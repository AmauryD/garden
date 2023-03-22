/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Command, CommandParams } from "../base"
import { findProjectConfig } from "../../config/base"
import { ensureDir, copy, remove, pathExists, writeFile } from "fs-extra"
import { getPackageVersion } from "../../util/util"
import { platform, release } from "os"
import { join, relative, basename, dirname } from "path"
import { Log } from "../../logger/log-entry"
import { findConfigPathsInPath, defaultDotIgnoreFile } from "../../util/fs"
import { ERROR_LOG_FILENAME } from "../../constants"
import dedent = require("dedent")
import { Garden } from "../../garden"
import { zipFolder } from "../../util/archive"
import chalk from "chalk"
import { GitHandler } from "../../vcs/git"
import { ValidationError } from "../../exceptions"
import { ChoicesParameter, BooleanParameter } from "../../cli/params"
import { printHeader } from "../../logger/util"
import { TreeCache } from "../../cache"
import { safeDumpYaml } from "../../util/serialization"

export const TEMP_DEBUG_ROOT = "tmp"
export const SYSTEM_INFO_FILENAME_NO_EXT = "system-info"
export const DEBUG_ZIP_FILENAME = "debug-info-TIMESTAMP.zip"
export const PROVIDER_INFO_FILENAME_NO_EXT = "info"

/**
 * Collects project and modules configuration files and error logs (in case they exist).
 * The files are copied over a temporary folder and mantain the folder structure from where
 * they are copied from.
 *
 * @export
 * @param {string} root Project root path
 * @param {string} gardenDirPath Path to the Garden cache directory
 * @param {Log} log Logger
 */
export async function collectBasicDebugInfo(root: string, gardenDirPath: string, log: Log) {
  // Find project definition
  const projectConfig = await findProjectConfig(log, root, true)
  if (!projectConfig) {
    throw new ValidationError(
      "Couldn't find a Project definition. Please run this command from the root of your Garden project.",
      {}
    )
  }

  // Create temporary folder inside .garden/ at root of project
  const tempPath = join(gardenDirPath, TEMP_DEBUG_ROOT)
  await remove(tempPath)
  await ensureDir(tempPath)

  // Copy project definition in tmp folder
  const projectConfigFilePath = projectConfig.configPath!
  const projectConfigFilename = basename(projectConfigFilePath)
  await copy(projectConfigFilePath, join(tempPath, projectConfigFilename))

  // Check if error logs exist and copy it over if it does
  if (await pathExists(join(root, ERROR_LOG_FILENAME))) {
    await copy(join(root, ERROR_LOG_FILENAME), join(tempPath, ERROR_LOG_FILENAME))
  }

  // Find all services paths
  const cache = new TreeCache()
  const vcs = new GitHandler({
    projectRoot: root,
    gardenDirPath,
    ignoreFile: projectConfig.dotIgnoreFile || defaultDotIgnoreFile,
    cache,
  })
  const include = projectConfig.modules && projectConfig.modules.include
  const exclude = projectConfig.modules && projectConfig.modules.exclude
  const paths = await findConfigPathsInPath({ vcs, dir: root, include, exclude, log })

  // Copy all the service configuration files
  for (const configPath of paths) {
    const servicePath = dirname(configPath)
    const gardenPathLog = log.createLog({ name: relative(root, servicePath) || "/", showDuration: true })
    gardenPathLog.info("collecting info")
    const tempServicePath = join(tempPath, relative(root, servicePath))
    await ensureDir(tempServicePath)
    const moduleConfigFilename = basename(configPath)
    const gardenLog = gardenPathLog.createLog({ name: moduleConfigFilename, showDuration: true })
    gardenLog.info("collecting garden.yml")
    await copy(configPath, join(tempServicePath, moduleConfigFilename))
    gardenLog.success(`Done`)
    // Check if error logs exist and copy them over if they do
    if (await pathExists(join(servicePath, ERROR_LOG_FILENAME))) {
      const errorLog = gardenPathLog.createLog({
        name: ERROR_LOG_FILENAME,
        showDuration: true,
      })
      errorLog.info(`collecting ${ERROR_LOG_FILENAME}`)
      await copy(join(servicePath, ERROR_LOG_FILENAME), join(tempServicePath, ERROR_LOG_FILENAME))
      errorLog.success(`Done`)
    }
    gardenPathLog.success(`Done`)
  }
}

/**
 * Collects informations about garden, the OS and docker.
 * Saves all the informations as json in a temporary folder.
 *
 * @export
 * @param {string} gardenDirPath Path to the Garden cache directory
 * @param {Log} log Logger
 */
export async function collectSystemDiagnostic(gardenDirPath: string, log: Log, format: string) {
  const tempPath = join(gardenDirPath, TEMP_DEBUG_ROOT)
  await ensureDir(tempPath)

  const systemLog = log.createLog({ name: "Operating System", showDuration: true })
  systemLog.info("collecting info")
  const gardenLog = log.createLog({ name: "Garden", showDuration: true })
  gardenLog.info("getting version")

  const systemInfo = {
    gardenVersion: getPackageVersion(),
    platform: platform(),
    platformVersion: release(),
  }

  systemLog.success(`Done`)
  gardenLog.success(`Done`)

  const outputFileName = `${SYSTEM_INFO_FILENAME_NO_EXT}.${format}`
  await writeFile(join(tempPath, outputFileName), renderInfo(systemInfo, format), "utf8")
}

/**
 * Generates a report with debug information for each provider which implements the action
 * The reports are saved in a temporary and follows the structure "tmp/provider-name/info.json".
 *
 * @export
 * @param {Garden} garden The Garden instance
 * @param {Log} log  Logger
 * @param {string} format The extension format dictating the extension of the report
 * @param {string} includeProject Extended export
 */
export async function collectProviderDebugInfo(garden: Garden, log: Log, format: string, includeProject: boolean) {
  const tempPath = join(garden.gardenDirPath, TEMP_DEBUG_ROOT)
  await ensureDir(tempPath)
  // Collect debug info from providers
  const actions = await garden.getActionRouter()
  const providersDebugInfo = await actions.provider.getDebugInfo({ log, includeProject })

  // Create a provider folder and report for each provider.
  for (const [providerName, info] of Object.entries(providersDebugInfo)) {
    const prividerPath = join(tempPath, providerName)
    await ensureDir(prividerPath)
    const outputFileName = `${PROVIDER_INFO_FILENAME_NO_EXT}.${format}`
    await writeFile(join(prividerPath, outputFileName), renderInfo(info, format), "utf8")
  }
}

/**
 * Collects information about the project and the system running garden.
 * Creates a zip file with the debug information at the root of the project.
 * Accepts an invalid project and it will always generate a report.
 * THIS SHOULD ONLY BE CALLED FROM `cli.ts`.
 *
 * @export
 * @param {string} root
 * @param {Log} log
 */
export async function generateBasicDebugInfoReport(root: string, gardenDirPath: string, log: Log, format = "json") {
  log.warn(chalk.yellow("It looks like Garden couldn't validate your project: generating basic report."))

  const tempPath = join(gardenDirPath, TEMP_DEBUG_ROOT)
  log.info({ msg: "Collecting basic debug info" })
  // Collect project info
  const projectLog = log.createLog({ name: "Project configuration", showDuration: true })
  projectLog.info("collecting info")
  await collectBasicDebugInfo(root, gardenDirPath, projectLog)
  projectLog.success(`Done`)

  // Run system diagnostic
  const systemLog = log.createLog({ name: "System", showDuration: true })
  systemLog.info("collecting info")
  await collectSystemDiagnostic(gardenDirPath, systemLog, format)
  systemLog.success(`Done`)

  // Zip report folder
  log.info("Preparing archive")
  const outputFilename = DEBUG_ZIP_FILENAME.replace("TIMESTAMP", new Date().toISOString())
  const outputFilePath = join(root, outputFilename)
  await zipFolder(tempPath, outputFilePath, log)

  // Cleanup temporary folders
  await remove(tempPath)

  log.success("Done")
  log.info(`\nDone! Please find your report at  ${outputFilePath}.`)
}

/**
 * Returns the input object as json or yaml string
 * Defaults to yaml.
 *
 * @param {*} info The input data
 * @param {string} format The format of the output. Default is yaml.
 * @returns The info rendered in either json or yaml
 */
function renderInfo(info: any, format: string) {
  if (format === "json") {
    return JSON.stringify(info, null, 4)
  } else {
    return safeDumpYaml(info, { noRefs: true })
  }
}

const debugInfoArguments = {}

const debugInfoOptions = {
  "format": new ChoicesParameter({
    help: "The output format for plugin-generated debug info.",
    choices: ["json", "yaml"],
    defaultValue: "json",
  }),
  "include-project": new BooleanParameter({
    help: dedent`
      Include project-specific information from configured providers.
      Note that this may include sensitive data, depending on the provider and your configuration.`,
    defaultValue: false,
  }),
}

type Args = typeof debugInfoArguments
type Opts = typeof debugInfoOptions

/**
 * Collects information about the project, the system running garden and the providers.
 * Creates a zip file with the debug information at the root of the project.
 *
 * @export
 * @class GetDebugInfoCommand
 * @extends {Command<Args, Opts>}
 */
export class GetDebugInfoCommand extends Command<Args, Opts> {
  name = "debug-info"
  help = "Outputs the status of your environment for debug purposes."

  description = dedent`
    Examples:

    garden get debug-info                    # create a zip file at the root of the project with debug information
    garden get debug-info --format yaml      # output provider info as YAML files (default is JSON)
    garden get debug-info --include-project  # include provider info for the project namespace (disabled by default)
  `

  arguments = debugInfoArguments
  options = debugInfoOptions

  printHeader({ headerLog }) {
    printHeader(headerLog, "Get debug info", "information_source")
  }

  async action({ garden, log, opts }: CommandParams<Args, Opts>) {
    const tempPath = join(garden.gardenDirPath, TEMP_DEBUG_ROOT)

    log.info({ msg: "Collecting debug info" })

    // Collect project info
    const projectLog = log.createLog({ name: "Project configuration", showDuration: true })
    projectLog.info("collecting info")
    await collectBasicDebugInfo(garden.projectRoot, garden.gardenDirPath, projectLog)
    projectLog.success(`Done`)

    // Run system diagnostic
    const systemLog = log.createLog({ name: "System", showDuration: true })
    systemLog.info("collecting info")
    await collectSystemDiagnostic(garden.projectRoot, systemLog, opts.format)
    systemLog.success(`Done`)

    // Collect providers info
    const providerLog = log.createLog({ name: "Providers", showDuration: true })
    providerLog.info("collecting info")
    try {
      await collectProviderDebugInfo(garden, providerLog, opts.format, opts["include-project"])
      providerLog.success(`Done`)
    } catch (err) {
      // One or multiple providers threw an error while processing.
      // Skip the step but still create a report.
      providerLog.warn(chalk.yellow(`Failed to collect providers info. Skipping this step.`))
    }

    // Zip report folder
    log.info("Preparing archive")
    const outputFilename = DEBUG_ZIP_FILENAME.replace("TIMESTAMP", new Date().toISOString())
    const outputFilePath = join(garden.projectRoot, outputFilename)
    await zipFolder(tempPath, outputFilePath, log)

    // Cleanup temporary folders
    await remove(tempPath)

    log.success("Done")

    log.info(chalk.green(`\nDone! Please find your report at  ${outputFilePath}.\n`))

    log.warn(
      chalk.yellow(dedent`
        NOTE: Please be aware that the output file might contain sensitive information.
        If you plan to make the file available to the general public (e.g. GitHub), please review the content first.
        If you need to share a file containing sensitive information with the Garden team, please contact us on
        our Discord community: https://discord.gg/gxeuDgp6Xt.
      `)
    )

    return { result: 0 }
  }
}

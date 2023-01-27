/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import td from "testdouble"
import { join, relative, resolve } from "path"
import { cloneDeep, extend, get, intersection, mapValues, merge, omit, pick, uniq } from "lodash"
import { copy, ensureDir, mkdirp, pathExists, remove, truncate } from "fs-extra"

import { buildExecAction, convertExecModule } from "../src/plugins/exec/exec"
import { createSchema, joiArray } from "../src/config/common"
import { createGardenPlugin, GardenPluginSpec, ProviderHandlers, RegisterPluginParam } from "../src/plugin/plugin"
import { Garden, GardenOpts } from "../src/garden"
import { ModuleConfig } from "../src/config/module"
import { ModuleVersion } from "../src/vcs/vcs"
import { DEFAULT_API_VERSION, GARDEN_CORE_ROOT, gardenEnv, LOCAL_CONFIG_FILENAME } from "../src/constants"
import { globalOptions, GlobalOptions, Parameters, ParameterValues } from "../src/cli/params"
import { ConfigureModuleParams } from "../src/plugin/handlers/module/configure"
import { ExternalSourceType, getRemoteSourceRelPath, hashRepoUrl } from "../src/util/ext-source-util"
import { CommandParams, ProcessCommandResult } from "../src/commands/base"
import { SuiteFunction, TestFunction } from "mocha"
import { AnalyticsGlobalConfig } from "../src/config-store"
import { EventLogEntry, TestGarden, TestGardenOpts } from "../src/util/testing"
import { Logger, LogLevel } from "../src/logger/logger"
import { ClientAuthToken } from "../src/db/entities/client-auth-token"
import { GardenCli } from "../src/cli/cli"
import { profileAsync } from "../src/util/profiling"
import { defaultDotIgnoreFile, makeTempDir } from "../src/util/fs"
import { DirectoryResult } from "tmp-promise"
import { ConfigurationError } from "../src/exceptions"
import Bluebird = require("bluebird")
import execa = require("execa")
import timekeeper = require("timekeeper")
import {
  execBuildSpecSchema,
  ExecModule,
  execModuleSpecSchema,
  execTaskSpecSchema,
  execTestSchema,
} from "../src/plugins/exec/moduleConfig"
import {
  execBuildActionSchema,
  execDeployActionSchema,
  execDeployCommandSchema,
  ExecRun,
  execRunActionSchema,
  ExecTest,
  execTestActionSchema,
} from "../src/plugins/exec/config"
import { RunActionHandler, TestActionHandler } from "../src/plugin/action-types"
import { GetRunResult } from "../src/plugin/handlers/run/get-result"
import { defaultEnvironment, defaultNamespace, ProjectConfig } from "../src/config/project"
import { ConvertModuleParams } from "../src/plugin/handlers/module/convert"
import { baseServiceSpecSchema } from "../src/config/service"
import { GraphResultMap } from "../src/graph/results"

export { TempDirectory, makeTempDir } from "../src/util/fs"
export { TestGarden, TestError, TestEventBus, expectError, expectFuzzyMatch } from "../src/util/testing"

// TODO-G2: split test plugin into new module

const testDataDir = resolve(GARDEN_CORE_ROOT, "test", "data")
const testNow = new Date()
const testModuleVersionString = "v-1234512345"
export const testModuleVersion: ModuleVersion = {
  versionString: testModuleVersionString,
  dependencyVersions: {},
  files: [],
}

// All test projects use this git URL
export const testGitUrl = "https://my-git-server.com/my-repo.git#main"
export const testGitUrlHash = hashRepoUrl(testGitUrl)

/**
 * Returns a fully resolved path of a concrete subdirectory located in the {@link testDataDir}.
 * The concrete subdirectory path is defined as a varargs list of its directory names.
 * E.g. `"project", "service-1"` stands for the path `project/service-1`.
 *
 * @param names the subdirectory path
 */
export function getDataDir(...names: string[]) {
  return resolve(testDataDir, ...names)
}

export function getExampleDir(name: string) {
  return resolve(GARDEN_CORE_ROOT, "..", "examples", name)
}

export async function profileBlock(description: string, block: () => Promise<any>) {
  // tslint:disable: no-console
  const startTime = new Date().getTime()
  const result = await block()
  const executionTime = new Date().getTime() - startTime
  console.log(description, "took", executionTime, "ms")
  return result
}

export const projectRootA = getDataDir("test-project-a")
export const projectRootBuildDependants = getDataDir("test-build-dependants")

export const testModuleSpecSchema = () =>
  execModuleSpecSchema().keys({
    build: execBuildSpecSchema(),
    services: joiArray(baseServiceSpecSchema()),
    tests: joiArray(execTestSchema()),
    tasks: joiArray(execTaskSpecSchema()),
  })

export const testDeploySchema = createSchema({
  name: "test.Deploy",
  extend: execDeployActionSchema,
  keys: {
    // Making this optional for tests
    deployCommand: execDeployCommandSchema().optional(),
  },
})
export const testRunSchema = createSchema({
  name: "test.Run",
  extend: execRunActionSchema,
  keys: {},
})
export const testTestSchema = createSchema({
  name: "test.Test",
  extend: execTestActionSchema,
  keys: {},
})

export async function configureTestModule({ moduleConfig }: ConfigureModuleParams) {
  // validate services
  moduleConfig.serviceConfigs = moduleConfig.spec.services.map((spec) => ({
    name: spec.name,
    dependencies: spec.dependencies,
    disabled: spec.disabled,
    sourceModuleName: spec.sourceModuleName,
    spec,
  }))

  moduleConfig.taskConfigs = moduleConfig.spec.tasks.map((t) => ({
    name: t.name,
    dependencies: t.dependencies,
    disabled: t.disabled,
    spec: t,
    timeout: t.timeout,
  }))

  moduleConfig.testConfigs = moduleConfig.spec.tests.map((t) => ({
    name: t.name,
    dependencies: t.dependencies,
    disabled: t.disabled,
    spec: t,
    timeout: t.timeout,
  }))

  return { moduleConfig }
}

const runTest: RunActionHandler<"run", ExecRun> = async ({ action, log }): Promise<GetRunResult> => {
  const { command } = action.getSpec()

  log.info("Run command: " + command.join(" "))

  return {
    state: "ready",
    detail: {
      completedAt: testNow,
      log: command.join(" "),
      startedAt: testNow,
      success: true,
    },
    outputs: {},
  }
}

const testPluginSecrets: { [key: string]: string } = {}

export const testPlugin = () =>
  createGardenPlugin({
    name: "test-plugin",
    dashboardPages: [
      {
        name: "test",
        description: "Test dashboard page",
        title: "Test",
        newWindow: false,
      },
    ],
    handlers: {
      async configureProvider({ config }) {
        for (let member in testPluginSecrets) {
          delete testPluginSecrets[member]
        }
        return { config }
      },

      async getDashboardPage({ page }) {
        return { url: `http://localhost:12345/${page.name}` }
      },

      async getEnvironmentStatus() {
        return { ready: true, outputs: { testKey: "testValue" } }
      },

      async prepareEnvironment() {
        return { status: { ready: true, outputs: { testKey: "testValue" } } }
      },

      async getDebugInfo() {
        return {
          info: {
            exampleData: "data",
            exampleData2: "data2",
          },
        }
      },
    },

    createActionTypes: {
      Build: [
        {
          name: "test",
          docs: "Test Build action",
          schema: execBuildActionSchema(),
          handlers: {
            build: buildExecAction,
            getStatus: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "not-ready", detail: null, outputs: {} }
            },
          },
        },
      ],
      Deploy: [
        {
          name: "test",
          docs: "Test Deploy action",
          schema: testDeploySchema(),
          handlers: {
            deploy: async ({}) => {
              return { state: "ready", detail: { state: "ready", detail: {} }, outputs: {} }
            },
            getStatus: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "ready", detail: { state: "ready", detail: {} }, outputs: {} }
            },
            exec: async ({ command }) => {
              return { code: 0, output: "Ran command: " + command.join(" ") }
            },
          },
        },
      ],
      Run: [
        {
          name: "test",
          docs: "Test Run action",
          schema: testRunSchema(),
          handlers: {
            run: runTest,
            getResult: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "not-ready", detail: null, outputs: {} }
            },
          },
        },
      ],
      Test: [
        {
          name: "test",
          docs: "Test Test action",
          schema: testTestSchema(),
          handlers: {
            run: <TestActionHandler<"run", ExecTest>>(<unknown>runTest),
            getResult: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "not-ready", detail: null, outputs: {} }
            },
          },
        },
      ],
    },

    createModuleTypes: [
      {
        name: "test",
        docs: "Test module type",
        schema: testModuleSpecSchema(),
        needsBuild: true,
        handlers: {
          // We want all the actions from the exec conversion.
          convert: async (params: ConvertModuleParams) => {
            const module: ExecModule = params.module
            const result = await convertExecModule({ ...params, module })
            // Override action type
            for (const action of result.group.actions) {
              action.type = <any>"test"
            }
            return result
          },
          configure: configureTestModule,

          async getModuleOutputs() {
            return { outputs: { foo: "bar" } }
          },
        },
      },
    ],
  })

export const customizedTestPlugin = (partialCustomSpec: Partial<GardenPluginSpec>) => {
  const base = testPlugin()
  merge(base, partialCustomSpec)
  return base
}

export const testPluginB = () => {
  const base = testPlugin()

  return createGardenPlugin({
    ...base,
    name: "test-plugin-b",
    dependencies: [{ name: "test-plugin" }],
    createModuleTypes: [],
    // This doesn't actually change any behavior, except to use this provider instead of test-plugin
    // TODO-G2: change to extend action types
    // extendModuleTypes: [
    //   {
    //     name: "test",
    //     handlers: base.createModuleTypes![0].handlers,
    //   },
    // ],
  })
}

export const testPluginC = () => {
  const base = testPlugin()

  return createGardenPlugin({
    ...base,
    name: "test-plugin-c",
    // TODO-G2: change to create action types
    createModuleTypes: [
      {
        name: "test-c",
        docs: "Test module type C",
        schema: testModuleSpecSchema(),
        handlers: base.createModuleTypes![0].handlers,
        needsBuild: true,
      },
    ],
  })
}

export const getDefaultProjectConfig = (): ProjectConfig =>
  cloneDeep({
    apiVersion: DEFAULT_API_VERSION,
    kind: "Project",
    name: "test",
    path: "tmp",
    defaultEnvironment,
    dotIgnoreFile: defaultDotIgnoreFile,
    environments: [{ name: "default", defaultNamespace, variables: {} }],
    providers: [],
    variables: {},
  })

export const createProjectConfig = (partialCustomConfig: Partial<ProjectConfig>): ProjectConfig => {
  const baseConfig = getDefaultProjectConfig()
  return merge(baseConfig, partialCustomConfig)
}

export const defaultModuleConfig: ModuleConfig = {
  apiVersion: DEFAULT_API_VERSION,
  type: "test",
  name: "test",
  path: "bla",
  allowPublish: false,
  build: { dependencies: [] },
  disabled: false,
  spec: {
    services: [
      {
        name: "test-service",
        dependencies: [],
      },
    ],
    tests: [],
    tasks: [],
  },
  serviceConfigs: [
    {
      name: "test-service",
      dependencies: [],
      disabled: false,
      spec: {},
    },
  ],
  testConfigs: [],
  taskConfigs: [],
}

export class TestGardenCli extends GardenCli {
  async getGarden(workingDir: string, opts: GardenOpts) {
    return makeTestGarden(workingDir, opts)
  }
}

export const makeTestModule = (params: Partial<ModuleConfig> = {}): ModuleConfig => {
  // deep merge `params` config into `defaultModuleConfig`
  return merge(cloneDeep(defaultModuleConfig), params)
}

// Similar to `makeTestModule`, but uses a more minimal default config.
export function makeModuleConfig(path: string, from: Partial<ModuleConfig>): ModuleConfig {
  return {
    apiVersion: DEFAULT_API_VERSION,
    allowPublish: false,
    build: { dependencies: [] },
    disabled: false,
    include: [],
    name: "test",
    path,
    serviceConfigs: [],
    taskConfigs: [],
    spec: {},
    testConfigs: [],
    type: "test",
    ...from,
  }
}

export const testPlugins = () => [testPlugin(), testPluginB(), testPluginC()]

export const testProjectTempDirs: { [root: string]: DirectoryResult } = {}

/**
 * Create a garden instance for testing and setup a project if it doesn't exist already.
 */
export const makeTestGarden = profileAsync(async function _makeTestGarden(
  projectRoot: string,
  opts: TestGardenOpts = {}
): Promise<TestGarden> {
  let targetRoot = projectRoot

  if (!opts.noTempDir) {
    if (!testProjectTempDirs[projectRoot]) {
      // Clone the project root to a temp directory
      testProjectTempDirs[projectRoot] = await makeTempDir({ git: true })
      targetRoot = join(testProjectTempDirs[projectRoot].path, "project")
      await ensureDir(targetRoot)

      await copy(projectRoot, targetRoot, {
        // Don't copy the .garden directory if it exists
        filter: (src: string) => {
          const relSrc = relative(projectRoot, src)
          return relSrc !== ".garden"
        },
      })

      if (opts.config?.path) {
        opts.config.path = targetRoot
      }
      if (opts.config?.configPath) {
        throw new ConfigurationError(`Please don't set the configPath here :) Messes with the temp dir business.`, {})
      }
    }
    targetRoot = join(testProjectTempDirs[projectRoot].path, "project")
  }

  const plugins = opts.onlySpecifiedPlugins ? opts.plugins : [...testPlugins(), ...(opts.plugins || [])]

  return TestGarden.factory(targetRoot, { ...opts, plugins })
})

export const makeTestGardenA = profileAsync(async function _makeTestGardenA(
  extraPlugins: RegisterPluginParam[] = [],
  opts?: TestGardenOpts
) {
  return makeTestGarden(projectRootA, { plugins: extraPlugins, forceRefresh: true, ...opts })
})

export const makeTestGardenBuildDependants = profileAsync(async function _makeTestGardenBuildDependants(
  extraPlugins: RegisterPluginParam[] = [],
  opts?: TestGardenOpts
) {
  return makeTestGarden(projectRootBuildDependants, { plugins: extraPlugins, forceRefresh: true, ...opts })
})

export async function stubProviderAction<T extends keyof ProviderHandlers>(
  garden: Garden,
  pluginName: string,
  type: T,
  handler?: ProviderHandlers[T]
) {
  if (handler) {
    handler["pluginName"] = pluginName
  }
  const actions = await garden.getActionRouter()
  return td.replace(actions.provider["pluginHandlers"][type], pluginName, handler)
}

/**
 * Returns an alphabetically sorted list of all processed actions including dependencies from a GraphResultMap.
 */
export function getAllProcessedTaskNames(results: GraphResultMap) {
  const all = Object.keys(results)

  for (const r of Object.values(results)) {
    if (r?.dependencyResults) {
      all.push(...getAllProcessedTaskNames(r.dependencyResults))
    }
  }

  return uniq(all).sort()
}

/**
 * Returns a map of all task results including dependencies from a GraphResultMap.
 */
export function getAllTaskResults(results: GraphResultMap) {
  const all = { ...results }

  for (const r of Object.values(results)) {
    if (r?.dependencyResults) {
      for (const [key, result] of Object.entries(getAllTaskResults(r.dependencyResults))) {
        all[key] = result
      }
    }
  }

  return all
}

export function taskResultOutputs(results: ProcessCommandResult) {
  return mapValues(results.graphResults, (r) => r?.result && omit(r.result, "executedAction"))
}

export const cleanProject = async (gardenDirPath: string) => {
  return remove(gardenDirPath)
}

export function withDefaultGlobalOpts<T extends object>(opts: T) {
  return <ParameterValues<GlobalOptions> & T>extend(
    mapValues(globalOptions, (opt) => opt.defaultValue),
    opts
  )
}

export function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform })
}

export function freezeTime(date?: Date) {
  if (!date) {
    date = new Date()
  }
  timekeeper.freeze(date)
  return date
}

export async function resetLocalConfig(gardenDirPath: string) {
  const path = join(gardenDirPath, LOCAL_CONFIG_FILENAME)
  if (await pathExists(path)) {
    await truncate(path)
  }
}

/**
 * Idempotently initializes the test-project-ext-project-sources project and returns
 * the Garden class.
 */
export async function makeExtProjectSourcesGarden(opts: TestGardenOpts = {}) {
  const projectRoot = getDataDir("test-project-ext-project-sources")
  // Borrow the external sources from here:
  const extSourcesRoot = getDataDir("test-project-local-project-sources")
  const sourceNames = ["source-a", "source-b", "source-c"]
  return prepareRemoteGarden({ projectRoot, extSourcesRoot, sourceNames, type: "project", opts })
}

/**
 * Idempotently initializes the test-project-ext-project-sources project and returns
 * the Garden class.
 */
export async function makeExtModuleSourcesGarden(opts: TestGardenOpts = {}) {
  const projectRoot = getDataDir("test-project-ext-module-sources")
  // Borrow the external sources from here:
  const extSourcesRoot = getDataDir("test-project-local-module-sources")
  const sourceNames = ["module-a", "module-b", "module-c"]
  return prepareRemoteGarden({ projectRoot, extSourcesRoot, sourceNames, type: "module", opts })
}

/**
 * Helper function for idempotently initializing the ext-sources projects.
 * Copies the external sources into the .garden directory and git inits them.
 */
async function prepareRemoteGarden({
  projectRoot,
  extSourcesRoot,
  sourceNames,
  type,
  opts = {},
}: {
  projectRoot: string
  extSourcesRoot: string
  sourceNames: string[]
  type: ExternalSourceType
  opts?: TestGardenOpts
}) {
  const garden = await makeTestGarden(projectRoot, opts)
  const sourcesPath = join(garden.projectRoot, ".garden", "sources", type)

  await mkdirp(sourcesPath)
  // Copy the sources to the `.garden/sources` dir and git init them
  await Bluebird.map(sourceNames, async (name) => {
    const remoteSourceRelPath = getRemoteSourceRelPath({ name, url: testGitUrl, sourceType: type })
    const targetPath = join(garden.projectRoot, ".garden", remoteSourceRelPath)
    await copy(join(extSourcesRoot, name), targetPath)
    await execa("git", ["init", "--initial-branch=main"], { cwd: targetPath })
  })

  return garden
}

/**
 * Trims the ends of each line of the given input string (useful for multi-line string comparisons)
 */
export function trimLineEnds(str: string) {
  return str
    .split("\n")
    .map((line) => line.trimRight())
    .join("\n")
}

const skipGroups = gardenEnv.GARDEN_SKIP_TESTS.split(" ")

/**
 * Helper function that wraps mocha functions and assigns them to one or more groups.
 *
 * If any of the specified `groups` are included in the `GARDEN_SKIP_TESTS` environment variable
 * (which should be specified as a space-delimited string, e.g. `GARDEN_SKIP_TESTS="group-a group-b"`),
 * the test or suite is skipped.
 *
 * Usage example:
 *
 *   // Skips the test if GARDEN_SKIP_TESTS=some-group
 *   grouped("some-group").it("should do something", () => { ... })
 *
 * @param groups   The group or groups of the test/suite (specify one string or array of strings)
 */
export function grouped(...groups: string[]) {
  const wrapTest = (fn: TestFunction) => {
    if (intersection(groups, skipGroups).length > 0) {
      return fn.skip
    } else {
      return fn
    }
  }

  const wrapSuite = (fn: SuiteFunction) => {
    if (intersection(groups, skipGroups).length > 0) {
      return fn.skip
    } else {
      return fn
    }
  }

  return {
    it: wrapTest(it),
    describe: wrapSuite(describe),
    context: wrapSuite(context),
  }
}

/**
 * Helper function that enables analytics while testing by updating the global config
 * and setting the appropriate environment variables.
 *
 * Returns a reset function that resets the config and environment variables to their
 * previous state.
 *
 * Call this function in a `before` hook and the reset function in an `after` hook.
 *
 * NOTE: Network calls to the analytics endpoint should be mocked when unit testing analytics.
 */
export async function enableAnalytics(garden: TestGarden) {
  const originalDisableAnalyticsEnvVar = gardenEnv.GARDEN_DISABLE_ANALYTICS
  const originalAnalyticsDevEnvVar = gardenEnv.ANALYTICS_DEV

  let originalAnalyticsConfig: AnalyticsGlobalConfig | undefined
  // Throws if analytics is not set
  try {
    // Need to clone object!
    originalAnalyticsConfig = { ...((await garden.globalConfigStore.get(["analytics"])) as AnalyticsGlobalConfig) }
  } catch {}

  gardenEnv.GARDEN_DISABLE_ANALYTICS = false
  // Set the analytics mode to dev for good measure
  gardenEnv.ANALYTICS_DEV = true

  const resetConfig = async () => {
    if (originalAnalyticsConfig) {
      await garden.globalConfigStore.set(["analytics"], originalAnalyticsConfig)
    } else {
      await garden.globalConfigStore.delete(["analytics"])
    }
    gardenEnv.GARDEN_DISABLE_ANALYTICS = originalDisableAnalyticsEnvVar
    gardenEnv.ANALYTICS_DEV = originalAnalyticsDevEnvVar
  }
  return resetConfig
}

export function getRuntimeStatusEvents(eventLog: EventLogEntry[]) {
  const runtimeEventNames = ["taskStatus", "testStatus", "serviceStatus"]
  return eventLog
    .filter((e) => runtimeEventNames.includes(e.name))
    .map((e) => {
      const cloned = { ...e }
      cloned.payload.status = pick(cloned.payload.status, ["state"])
      return cloned
    })
}

/**
 * Initialise test logger.
 *
 * It doesn't register any writers so it only collects logs but doesn't write them.
 */
export function initTestLogger() {
  // make sure logger is initialized
  try {
    Logger.initialize({
      level: LogLevel.info,
      storeEntries: true,
      type: "quiet",
    })
  } catch (_) {}
}

export async function cleanupAuthTokens() {
  await ClientAuthToken.createQueryBuilder().delete().execute()
}

export function makeCommandParams<T extends Parameters = {}, U extends Parameters = {}>({
  cli,
  garden,
  args,
  opts,
}: {
  cli?: GardenCli
  garden: Garden
  args: T
  opts: U
}): CommandParams<T, U> {
  const log = garden.log
  return {
    cli,
    garden,
    log,
    headerLog: log,
    footerLog: log,
    args,
    opts: withDefaultGlobalOpts(opts),
  }
}

type NameOfProperty = string
// https://stackoverflow.com/a/66836940
// useful for typesafe stubbing
export function getPropertyName<T>(
  obj: T,
  expression: (x: { [Property in keyof T]: () => string }) => () => NameOfProperty
): string {
  const res: { [Property in keyof T]: () => string } = {} as { [Property in keyof T]: () => string }

  Object.keys(obj).map((k) => (res[k as keyof T] = () => k))

  return expression(res)()
}

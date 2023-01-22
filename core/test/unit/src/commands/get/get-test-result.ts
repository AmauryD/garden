/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  expectError,
  withDefaultGlobalOpts,
  makeTestGardenA,
  cleanProject,
  TestGarden,
  customizedTestPlugin,
} from "../../../../helpers"
import { GetTestResultCommand } from "../../../../../src/commands/get/get-test-result"
import { expect } from "chai"
import { LogEntry } from "../../../../../src/logger/log-entry"
import { getArtifactKey } from "../../../../../src/util/artifacts"
import { join } from "path"
import { writeFile } from "fs-extra"
import { execTestActionSchema } from "../../../../../src/plugins/exec/config"
import { GetTestResult } from "../../../../../src/plugin/handlers/test/get-result"

const now = new Date()

describe("GetTestResultCommand", () => {
  let garden: TestGarden
  let log: LogEntry
  const command = new GetTestResultCommand()
  const moduleName = "module-a"

  beforeEach(async () => {
    garden = await makeTestGardenA(undefined, { noCache: true })
    log = garden.log
  })

  afterEach(async () => {
    await cleanProject(garden.gardenDirPath)
  })

  it("should throw error if test not found", async () => {
    const testName = "banana"

    await expectError(
      async () =>
        await command.action({
          garden,
          log,
          headerLog: log,
          footerLog: log,
          args: { name: moduleName, moduleTestName: testName },
          opts: withDefaultGlobalOpts({}),
        }),
      { type: "parameter", contains: `Could not find test "${testName}" in module ${moduleName}` }
    )
  })

  it("should return the test result", async () => {
    const status: GetTestResult = {
      detail: { success: true, startedAt: now, completedAt: now, log: "bla" },
      outputs: {
        log: "bla",
      },
      state: "ready",
    }

    await garden.setTestActionStatus({
      log,
      kind: "Test",
      name: "module-a-unit",
      status,
    })

    const res = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { name: "module-a-unit", moduleTestName: undefined },
      opts: withDefaultGlobalOpts({}),
    })

    console.log(res.result)

    expect(command.outputsSchema().validate(res.result).error).to.be.undefined

    expect(res.result).to.eql({
      ...status,
      artifacts: [],
    })
  })

  it("should return test result with module name as first argument", async () => {
    const status: GetTestResult = {
      detail: { success: true, startedAt: now, completedAt: now, log: "bla" },
      outputs: {
        log: "bla",
      },
      state: "ready",
    }

    await garden.setTestActionStatus({
      log,
      kind: "Test",
      name: "module-a-unit",
      status,
    })

    const res = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { name: moduleName, moduleTestName: "unit" },
      opts: withDefaultGlobalOpts({}),
    })

    expect(command.outputsSchema().validate(res.result).error).to.be.undefined

    expect(res.result).to.eql({
      ...status,
      artifacts: [],
    })
  })

  it("should include paths to artifacts if artifacts exist", async () => {
    const status: GetTestResult = {
      detail: { success: true, startedAt: now, completedAt: now, log: "bla" },
      outputs: {
        log: "bla",
      },
      state: "ready",
    }

    await garden.setTestActionStatus({
      log,
      kind: "Test",
      name: "module-a-unit",
      status,
    })

    const graph = await garden.getConfigGraph({ log: garden.log, emit: false, noCache: true })
    const testAction = graph.getTest("module-a-unit")
    const artifactKey = getArtifactKey("test", "module-a-unit", testAction.versionString())
    const metadataPath = join(garden.artifactsPath, `.metadata.${artifactKey}.json`)
    const metadata = {
      key: artifactKey,
      files: ["/foo/bar.txt", "/bas/bar.txt"],
    }

    await writeFile(metadataPath, JSON.stringify(metadata))

    const res = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: { name: moduleName, moduleTestName: "unit" },
      opts: withDefaultGlobalOpts({}),
    })

    expect(res.result).to.eql({
      ...status,
      artifacts: ["/foo/bar.txt", "/bas/bar.txt"],
    })
  })

  it("should return empty result if test result does not exist", async () => {
    const testName = "integration"

    const res = await command.action({
      garden,
      log,
      footerLog: log,
      headerLog: log,
      args: { name: moduleName, moduleTestName: testName },
      opts: withDefaultGlobalOpts({}),
    })

    expect(res.result).to.eql({
      artifacts: [],
      state: "not-ready",
      detail: null,
      outputs: {},
    })
  })
})

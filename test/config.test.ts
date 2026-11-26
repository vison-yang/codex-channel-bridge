import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadConfig, MAX_INBOUND_BYTES, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";

const defaultCodexTimeouts = {
  codexApprovalTimeoutMs: 600_000,
  codexTurnTimeoutMs: 86_400_000,
  codexRequestTimeoutMs: 600_000,
  codexUserInputTimeoutMs: 300_000
};
const codexTimeoutFields = Object.keys(defaultCodexTimeouts) as Array<keyof typeof defaultCodexTimeouts>;

test("uses ~/.codex-weixin as the default Codex workspace", () => {
  assert.equal(defaultConfig().defaultCwd, path.join(os.homedir(), ".codex-weixin"));
  assert.deepEqual(defaultConfig().allowedWorkspaces, [path.join(os.homedir(), ".codex-weixin")]);
  assert.equal(defaultConfig().streamReplies, true);
  assert.equal(defaultConfig().channelChatIntentClassification, false);
  assert.equal(defaultConfig().maxInboundBytes, 100 * 1024 * 1024);
  assert.equal(defaultConfig().taskboardEnabled, true);
  assert.equal(defaultConfig().taskboardUrl, "http://127.0.0.1:47823");
  assert.equal(resolveStatePaths("/tmp/codex-weixin-test").taskboardDir, "/tmp/codex-weixin-test/taskboard");
});

test("defaults old configurations to the chat fast path and preserves an explicit opt-in", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-intent-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({ streamReplies: false }));
  const legacy = loadConfig(paths, "/tmp/project");
  assert.equal(legacy.channelChatIntentClassification, false);
  assert.equal(legacy.streamReplies, false);

  saveConfig(paths, { ...legacy, channelChatIntentClassification: true });
  assert.equal(JSON.parse(fs.readFileSync(paths.configPath, "utf8")).channelChatIntentClassification, true);
  assert.equal(loadConfig(paths).channelChatIntentClassification, true);

  saveConfig(paths, { ...loadConfig(paths), channelChatIntentClassification: false });
  assert.equal(loadConfig(paths).channelChatIntentClassification, false);
  fs.writeFileSync(paths.configPath, JSON.stringify({ channelChatIntentClassification: "true" }));
  assert.equal(loadConfig(paths).channelChatIntentClassification, false);
});

test("migrates the legacy inbound limit and never exceeds 100 MiB", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-media-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 50 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, MAX_INBOUND_BYTES);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 200 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, MAX_INBOUND_BYTES);

  saveConfig(paths, { ...defaultConfig("/tmp/project"), maxInboundBytes: 200 * 1024 * 1024 });
  assert.equal(JSON.parse(fs.readFileSync(paths.configPath, "utf8")).maxInboundBytes, MAX_INBOUND_BYTES);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 25 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, 25 * 1024 * 1024);
});

test("enables process progress by default while preserving an explicit opt-out", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-progress-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  assert.equal(loadConfig(paths, "/tmp/project").streamReplies, true);
  fs.writeFileSync(paths.configPath, JSON.stringify({ streamReplies: false }));
  assert.equal(loadConfig(paths, "/tmp/project").streamReplies, false);
});

test("loads independent Feishu feedback switches for existing and updated configurations", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({ streamReplies: false }));
  let config = loadConfig(paths);
  assert.equal(config.feishuReactions, true);
  assert.equal(config.feishuProgressCards, true);
  assert.equal(config.feishuStreamingReplies, false);

  saveConfig(paths, { ...config, feishuReactions: false, feishuProgressCards: false, feishuStreamingReplies: true });
  config = loadConfig(paths);
  assert.equal(config.feishuReactions, false);
  assert.equal(config.feishuProgressCards, false);
  assert.equal(config.feishuStreamingReplies, true);
  assert.equal(config.streamReplies, false);
});

test("loads an explicit codex exec sandbox", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "danger-full-access" }));

  assert.equal(loadConfig(paths, "/tmp/project").codexExecSandbox, "danger-full-access");
});

test("rejects an invalid codex exec sandbox", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "unrestricted" }));

  assert.throws(
    () => loadConfig(paths, "/tmp/project"),
    /Invalid codexExecSandbox/
  );
});

test("loads Codex permission and timeout defaults for missing and older configurations", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-permission-defaults-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  const missing = loadConfig(paths, "/tmp/project");
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "workspace-write" }));
  const legacy = loadConfig(paths, "/tmp/project");

  assert.equal(missing.codexApprovalPolicy, undefined);
  assert.equal(missing.codexExecSandbox, undefined);
  assert.equal(legacy.codexApprovalPolicy, undefined);
  assert.equal(legacy.codexExecSandbox, "workspace-write");
  for (const field of codexTimeoutFields) {
    assert.equal(missing[field], defaultCodexTimeouts[field], field);
    assert.equal(legacy[field], defaultCodexTimeouts[field], field);
  }
});

test("loads and saves Codex approval policies and independent timeout overrides", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-permission-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  const timeouts = {
    codexApprovalTimeoutMs: 30_000,
    codexTurnTimeoutMs: 2_147_483_647,
    codexRequestTimeoutMs: 1,
    codexUserInputTimeoutMs: 20_000
  };

  for (const codexApprovalPolicy of ["untrusted", "on-request", "never"] as const) {
    saveConfig(paths, { ...defaultConfig(), ...timeouts, codexApprovalPolicy });
    const loaded = loadConfig(paths);
    assert.equal(loaded.codexApprovalPolicy, codexApprovalPolicy);
    for (const field of codexTimeoutFields) assert.equal(loaded[field], timeouts[field], field);
  }
});

test("supports explicit inheritance for both Codex permission settings", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-permission-inherit-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  for (const inherit of ["inherit", null]) {
    fs.writeFileSync(paths.configPath, JSON.stringify({ codexApprovalPolicy: inherit, codexExecSandbox: inherit }));
    const config = loadConfig(paths);
    assert.equal(config.codexApprovalPolicy, undefined);
    assert.equal(config.codexExecSandbox, undefined);
    saveConfig(paths, config);
    const stored = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
    assert.equal(Object.hasOwn(stored, "codexApprovalPolicy"), false);
    assert.equal(Object.hasOwn(stored, "codexExecSandbox"), false);
  }
});

test("reports invalid Codex config fields and preserves the file on save failure", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-invalid-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({ codexApprovalPolicy: "always" }));
  assert.throws(() => loadConfig(paths), /codexApprovalPolicy/);

  for (const field of codexTimeoutFields) {
    for (const value of [0, -1, 1.5, 2_147_483_648, "600000", null, true]) {
      fs.writeFileSync(paths.configPath, JSON.stringify({ [field]: value }));
      assert.throws(() => loadConfig(paths), new RegExp(field));
    }
  }

  const config = defaultConfig();
  saveConfig(paths, config);
  const stored = fs.readFileSync(paths.configPath, "utf8");
  assert.throws(() => saveConfig(paths, { ...config, codexTurnTimeoutMs: 0 }), /codexTurnTimeoutMs/);
  assert.equal(fs.readFileSync(paths.configPath, "utf8"), stored);
});

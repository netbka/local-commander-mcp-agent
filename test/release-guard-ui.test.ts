import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const bridge = path.resolve("release/windows/OwnerBridge.exe");
test("native owner review constructs safely without showing a window and defaults to rejection", {
  skip: process.platform !== "win32" || !existsSync(bridge) ? "Fresh Windows OwnerBridge required" : false
}, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$assembly = [Reflection.Assembly]::LoadFile('" + bridge.replaceAll("'", "''") + "')",
    "$method = $assembly.GetType('OwnerBridge').GetMethod('CreateGuardReview', [Reflection.BindingFlags]'NonPublic,Static')",
    "$form = $method.Invoke($null, @('Synthetic action <script> must stay literal'))",
    "try {",
    "$approve = $form.Controls.Find('approve', $true)[0]",
    "$reviewed = $form.Controls.Find('reviewed', $true)[0]",
    "$details = $form.Controls.Find('guard-summary', $true)[0]",
    "if ($form.Visible -or $approve.Enabled -or $reviewed.Checked) { throw 'UNSAFE_INITIAL_STATE' }",
    "if ($form.AcceptButton.Name -ne 'reject' -or $form.CancelButton.Name -ne 'reject') { throw 'UNSAFE_DEFAULT' }",
    "if (!$details.ReadOnly -or $details.Text -ne 'Synthetic action <script> must stay literal') { throw 'SUMMARY_INVALID' }",
    "$reviewed.Checked = $true",
    "if (!$approve.Enabled) { throw 'REVIEW_CANNOT_APPROVE' }",
    "$reviewed.Checked = $false",
    "if ($approve.Enabled) { throw 'REVIEW_BYPASS' }",
    "'GUARD_UI_CONSTRUCTION_OK'",
    "} finally { $form.Dispose() }"
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GUARD_UI_CONSTRUCTION_OK/);
});

const COMMON_ALLOWED_KEYS = new Set([
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "DOTNET_ROOT",
  "DOTNET_CLI_HOME"
]);

const WINDOWS_ALLOWED_KEYS = new Set([
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "USERDOMAIN",
  "PUBLIC"
]);

const POSIX_ALLOWED_KEYS = new Set([
  "SHELL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
]);

const DENIED_KEYS = new Set([
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "PERL5OPT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "NPM_CONFIG_USERCONFIG"
]);

const DENIED_SUBSTRINGS = [
  "LCMCP",
  "LOCAL_COMMANDER",
  "PAYPAL",
  "SQL",
  "CONNECTIONSTRING",
  "CONNECTION_STRING",
  "PASSWORD",
  "PASSWD",
  "SECRET",
  "TOKEN",
  "CREDENTIAL",
  "OPENAI",
  "ANTHROPIC",
  "API_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY"
];

function canonicalAllowedKeys(platform: NodeJS.Platform): Map<string, string> {
  const keys = new Set(COMMON_ALLOWED_KEYS);
  if (platform === "win32") {
    for (const key of WINDOWS_ALLOWED_KEYS) keys.add(key);
  } else {
    for (const key of POSIX_ALLOWED_KEYS) keys.add(key);
  }

  const result = new Map<string, string>();
  for (const key of keys) result.set(platform === "win32" ? key.toUpperCase() : key, key);
  return result;
}

function isDeniedKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DENIED_KEYS.has(upper)) return true;
  return DENIED_SUBSTRINGS.some((item) => upper.includes(item));
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const allowed = canonicalAllowedKeys(platform);
  const result: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();

  for (const [rawKey, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lookupKey = platform === "win32" ? rawKey.toUpperCase() : rawKey;
    const outputKey = allowed.get(lookupKey);
    if (!outputKey) continue;
    if (isDeniedKey(rawKey) || isDeniedKey(outputKey)) continue;
    if (seen.has(lookupKey)) continue;
    seen.add(lookupKey);
    result[outputKey] = value;
  }

  return result;
}

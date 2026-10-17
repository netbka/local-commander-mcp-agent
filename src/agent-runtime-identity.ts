import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { FabricStateFile } from "./agent-fabric-state.js";

const id = z.string().regex(/^rt-[0-9a-f-]{36}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_BINDINGS = 128;
const MAX_BYTES = 128 * 1024;

const BindingSchema = z.strictObject({
  runtimeId: id,
  keyHash: hash,
  createdAt: z.number().int().positive(),
  lastUsedAt: z.number().int().positive(),
  revoked: z.boolean()
});
const StateSchema = z.strictObject({
  version: z.literal(1),
  bindings: z.array(BindingSchema).max(MAX_BINDINGS)
});
type State = z.infer<typeof StateSchema>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
function encodedDigest(value: string): string {
  return digest(value).toString("hex");
}
function validKey(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export interface RuntimeCredential {
  runtimeId: string;
  runtimeKey: string;
}

export class AgentRuntimeIdentityStore {
  private readonly state: FabricStateFile<State>;
  constructor(file: string, private readonly now: () => number = Date.now) {
    this.state = new FabricStateFile(file, MAX_BYTES, value => {
      const state = StateSchema.parse(value);
      if (new Set(state.bindings.map(item => item.runtimeId)).size !== state.bindings.length)
        throw Error("RUNTIME_IDENTITY_STATE_CORRUPT");
      return state;
    });
  }
  private serial<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
    return this.state.update(fn, () => ({ version: 1, bindings: [] })).catch(error => {
      if (error instanceof Error && error.message.startsWith("FABRIC_STATE_"))
        throw Error(error.message.replace("FABRIC_STATE_", "RUNTIME_IDENTITY_STATE_"));
      throw error;
    });
  }

  issue(): Promise<RuntimeCredential> {
    return this.serial(state => {
      if (state.bindings.length >= MAX_BINDINGS) throw Error("RUNTIME_IDENTITY_LIMIT");
      const runtimeId = "rt-" + randomUUID();
      const runtimeKey = randomBytes(32).toString("base64url");
      const now = this.now();
      state.bindings.push({ runtimeId, keyHash: encodedDigest(runtimeKey), createdAt: now, lastUsedAt: now, revoked: false });
      return { runtimeId, runtimeKey };
    });
  }

  authenticate(runtimeId: string, runtimeKey: string): Promise<void> {
    return this.serial(state => {
      if (!id.safeParse(runtimeId).success || !validKey(runtimeKey)) throw Error("RUNTIME_IDENTITY_INVALID");
      const binding = state.bindings.find(item => item.runtimeId === runtimeId);
      if (!binding || binding.revoked) throw Error("RUNTIME_IDENTITY_DENIED");
      const expected = Buffer.from(binding.keyHash, "hex");
      const actual = digest(runtimeKey);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error("RUNTIME_IDENTITY_DENIED");
      binding.lastUsedAt = this.now();
    });
  }

  revoke(runtimeId: string, runtimeKey: string): Promise<void> {
    return this.serial(state => {
      if (!id.safeParse(runtimeId).success || !validKey(runtimeKey)) throw Error("RUNTIME_IDENTITY_INVALID");
      const binding = state.bindings.find(item => item.runtimeId === runtimeId);
      if (!binding || binding.revoked) throw Error("RUNTIME_IDENTITY_DENIED");
      const expected = Buffer.from(binding.keyHash, "hex");
      const actual = digest(runtimeKey);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error("RUNTIME_IDENTITY_DENIED");
      binding.revoked = true;
      binding.lastUsedAt = this.now();
    });
  }
}

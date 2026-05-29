import { isRecord } from "../mmr-core/internal/json.js";
import type { MmrModelRegistryLike, MmrRegisteredModelLike } from "../mmr-core/model-resolver.js";

/**
 * Adapt Pi's extension-context `modelRegistry` to the {@link MmrModelRegistryLike}
 * shape consumed by `selectMmrModelRoute`. Returns `undefined` when `ctx`
 * does not expose a registry with the required `getAll`/`find` methods, so
 * callers degrade to "no route selected" rather than throwing. The same
 * registry the child Pi process resolves against is used here, keeping
 * parent route selection and child activation in agreement.
 */
export function resolveCtxMmrModelRegistry<TModel extends MmrRegisteredModelLike>(
  ctx: unknown,
): MmrModelRegistryLike<TModel> | undefined {
  if (!isRecord(ctx)) return undefined;
  const registry = ctx.modelRegistry;
  if (!isRecord(registry)) return undefined;
  if (typeof registry.getAll !== "function") return undefined;
  if (typeof registry.find !== "function") return undefined;
  return registry as unknown as MmrModelRegistryLike<TModel>;
}

function readAvailableModels(ctx: unknown): unknown[] {
  if (!isRecord(ctx)) return [];
  const registry = ctx.modelRegistry;
  if (!isRecord(registry) || typeof registry.getAvailable !== "function") return [];
  try {
    const models = registry.getAvailable();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

function readModelId(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const id = model.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function readModelProvider(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const provider = model.provider;
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

export function readMmrModelContextWindow(model: unknown): number | undefined {
  if (!isRecord(model)) return undefined;
  const contextWindow = model.contextWindow;
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
}

export function listAvailableMmrWorkerModelsFromCtx(ctx: unknown): string[] {
  const flat: string[] = [];
  for (const entry of readAvailableModels(ctx)) {
    const id = readModelId(entry);
    if (!id) continue;
    const provider = readModelProvider(entry);
    if (provider) flat.push(`${provider}/${id}`);
    flat.push(id);
  }
  return flat;
}

export function resolveMmrWorkerModelContextWindowFromCtx(
  ctx: unknown,
  selectedModel: string | undefined,
): number | undefined {
  const selected = selectedModel?.trim();
  if (!selected) return undefined;
  const selectedHasProvider = selected.includes("/");
  const selectedTail = selected.split("/").filter(Boolean).pop() ?? selected;
  for (const entry of readAvailableModels(ctx)) {
    const id = readModelId(entry);
    if (!id) continue;
    const provider = readModelProvider(entry);
    const canonical = provider ? `${provider}/${id}` : id;
    if (selectedHasProvider) {
      if (selected === canonical || canonical.endsWith(`/${selected}`)) {
        return readMmrModelContextWindow(entry);
      }
      continue;
    }
    if (selected === canonical || selected === id || selectedTail === id) {
      return readMmrModelContextWindow(entry);
    }
  }
  return undefined;
}

import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { workerModelList } from "../../lib/pack/policy.ts";
import { pack } from "../../lib/runtime.ts";
import { modelInstructions, splitModelId } from "../../lib/workers/models.ts";

// The worker model list (decision 041): the pack's models, else the built-in ones, with
// SYM_WORKER_MODEL as the default. Pure: it reads the pack and the environment only.
export default defineDynamic((ctx) => {
  if (isWorkerCaller(ctx.session.auth.current)) return null;
  try {
    const adopterPack = pack();
    const raw = process.env.SYM_WORKER_MODEL?.trim();
    const env = raw && splitModelId(raw) ? raw : undefined;
    const workers = adopterPack?.config.workers ?? [];
    const lists =
      workers.length > 1
        ? workers.map((w) => ({
            worker: w.name,
            list: workerModelList(adopterPack, w.name, env),
          }))
        : [{ list: workerModelList(adopterPack, workers[0]?.name, env) }];
    return defineInstructions({ content: modelInstructions(lists) });
  } catch (error) {
    console.warn("worker-models: could not build the model list", error);
    return null;
  }
});

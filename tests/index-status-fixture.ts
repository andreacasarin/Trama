import { IndexStatusController } from "@/ui/index/IndexStatus";

type Actions = ConstructorParameters<typeof IndexStatusController>[1];

export function createTestIndexStatus(actions: Partial<Actions> = {}) {
  return new IndexStatusController({} as any, {
    update: async () => undefined,
    rebuild: async () => undefined,
    reset: async () => undefined,
    stop: () => undefined,
    ...actions,
  });
}

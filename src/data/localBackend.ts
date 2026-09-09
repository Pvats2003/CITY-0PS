import type { RemoteBackend } from "./backend";

/** The default backend — demo/local mode. Does nothing and calls nothing
 * over the network; the Zustand store's own localStorage persistence
 * (see src/store/city.ts) is the only source of truth in this mode. */
export const localBackend: RemoteBackend = {
  subscribeCollection() {
    return () => {};
  },
  async putDoc() {},
  async deleteDoc() {},
};

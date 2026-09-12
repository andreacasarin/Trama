/** Minimal public-API seam for resolving assets beside an installed plugin. */
export interface TalaPluginResourceAdapter {
  getResourcePath?(normalizedPath: string): string;
}

export function resolveTalaPluginMainResource(
  adapter: TalaPluginResourceAdapter,
  pluginDirectory: string
): string | undefined {
  if (!pluginDirectory) return undefined;
  return adapter.getResourcePath?.(`${pluginDirectory}/main.js`);
}

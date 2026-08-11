import { PluginHostContext } from './plugin-host-context';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PluginHostContext', () => {
  it('is null outside any bound call', () => {
    expect(PluginHostContext.current()).toBeNull();
  });

  it('returns the bound id throughout the call, including after an await', async () => {
    const seen = await PluginHostContext.runAs('plugin.alpha', async () => {
      const before = PluginHostContext.current();
      await sleep(5);
      const after = PluginHostContext.current();
      return [before, after];
    });
    expect(seen).toEqual(['plugin.alpha', 'plugin.alpha']);
  });

  it('keeps two concurrent, interleaved calls isolated from each other', async () => {
    const trace = async (
      pluginId: string,
      delays: number[],
    ): Promise<string[]> =>
      PluginHostContext.runAs(pluginId, async () => {
        const seen: string[] = [];
        for (const delay of delays) {
          await sleep(delay);
          seen.push(PluginHostContext.current()!);
        }
        return seen;
      });

    // Deliberately staggered so the two calls' `await`s land on opposite ticks —
    // a shared mutable variable (rather than AsyncLocalStorage) would fail this.
    const [alphaSeen, betaSeen] = await Promise.all([
      trace('plugin.alpha', [1, 4, 2]),
      trace('plugin.beta', [3, 1, 5]),
    ]);

    expect(alphaSeen).toEqual(['plugin.alpha', 'plugin.alpha', 'plugin.alpha']);
    expect(betaSeen).toEqual(['plugin.beta', 'plugin.beta', 'plugin.beta']);
    expect(PluginHostContext.current()).toBeNull();
  });
});

import * as fs from 'fs';
import { join } from 'path';
import { SystemController } from './system.controller';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(),
}));

describe('SystemController.restart', () => {
  const ENV = process.env;

  function makeController() {
    return new SystemController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.pm_id;
    delete process.env.INVOCATION_ID;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = ENV;
    process.exitCode = undefined;
  });

  it('refuses to exit when no supervisor would bring the server back', () => {
    delete process.env.FLIKS_SUPERVISED;
    jest.mocked(fs.existsSync).mockReturnValue(false);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    expect(() => makeController().restart()).toThrow();
    jest.runAllTimers();
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('signals a graceful shutdown with a non-zero exit code when supervised', () => {
    process.env.FLIKS_SUPERVISED = '1';
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    expect(makeController().restart()).toEqual({
      ok: true,
      supervisor: 'supervisor',
    });
    expect(process.exitCode).toBe(1);
    expect(kill).not.toHaveBeenCalled(); // only after the response flushes
    jest.runAllTimers();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('signals PID 1 in a container so the container itself exits', () => {
    delete process.env.FLIKS_SUPERVISED;
    jest.mocked(fs.existsSync).mockReturnValue(true);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    expect(makeController().restart()).toEqual({
      ok: true,
      supervisor: 'docker',
    });
    jest.runAllTimers();
    expect(kill).toHaveBeenCalledWith(1, 'SIGTERM');
  });
});

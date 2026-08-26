import { DEFAULT_SUPERVISOR_OPTIONS } from './plugin-supervisor';
import {
  HOST_CALL_DEADLINE_OVERRIDES_MS,
  PLUGIN_DEADLINES_MS,
  PLUGIN_DEFAULT_MEMORY_MB,
  PLUGIN_LOG_CAP_BYTES_PER_MINUTE,
} from '../../../common/plugin-contract';

/** Lives outside the contract directory's own emit: it imports the supervisor, which the
 *  island itself never may. Its job is to fail if a published figure stops being the real one. */
describe('published plugin deadlines', () => {
  it('are the figures the supervisor actually applies', () => {
    expect(DEFAULT_SUPERVISOR_OPTIONS.handshakeDeadlineMs).toBe(PLUGIN_DEADLINES_MS.handshake);
    expect(DEFAULT_SUPERVISOR_OPTIONS.healthIntervalMs).toBe(PLUGIN_DEADLINES_MS.healthInterval);
    expect(DEFAULT_SUPERVISOR_OPTIONS.healthDeadlineMs).toBe(PLUGIN_DEADLINES_MS.healthReply);
    expect(DEFAULT_SUPERVISOR_OPTIONS.hostCallTimeoutMs).toBe(PLUGIN_DEADLINES_MS.hostCall);
    expect(DEFAULT_SUPERVISOR_OPTIONS.shutdownRpcDeadlineMs).toBe(PLUGIN_DEADLINES_MS.shutdownRpc);
    expect(DEFAULT_SUPERVISOR_OPTIONS.sigtermGraceMs).toBe(PLUGIN_DEADLINES_MS.sigtermGrace);
    expect(DEFAULT_SUPERVISOR_OPTIONS.logCapBytesPerMinute).toBe(PLUGIN_LOG_CAP_BYTES_PER_MINUTE);
    expect(DEFAULT_SUPERVISOR_OPTIONS.memoryMb).toBe(PLUGIN_DEFAULT_MEMORY_MB);
  });

  it('carry the one host method allowed longer than the common ceiling', () => {
    expect(HOST_CALL_DEADLINE_OVERRIDES_MS['library.ingest']).toBeGreaterThan(PLUGIN_DEADLINES_MS.hostCall);
  });

  // A sweep over a few hundred candidates at seconds of indexer search each passes three minutes
  // long before it finishes, so a job bounded by the interactive route's ceiling is reported as
  // failed on every real library — and its overlap guard released while it is still running.
  it('VERDICT: a job is allowed far longer than a request someone is waiting on', () => {
    expect(PLUGIN_DEADLINES_MS.job).toBeGreaterThan(PLUGIN_DEADLINES_MS.pluginCall * 10);
  });
});

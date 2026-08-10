import { MAX_FRAME_BYTES } from '../../../common/plugin-contract';
import { encodeFrame, FrameReader, parseFrame, ProtocolViolationError } from './wire';

describe('encodeFrame / parseFrame', () => {
  it('round-trips a Req through one line', () => {
    const line = encodeFrame({ i: 1, m: 'health', p: {} }).toString('utf8');
    expect(line.endsWith('\n')).toBe(true);
    expect(parseFrame(line.slice(0, -1))).toEqual({ i: 1, m: 'health', p: {} });
  });

  it('rejects a malformed line', () => {
    expect(() => parseFrame('not json')).toThrow(ProtocolViolationError);
  });

  it('rejects a line that parses to a non-object', () => {
    expect(() => parseFrame('42')).toThrow(ProtocolViolationError);
    expect(() => parseFrame('null')).toThrow(ProtocolViolationError);
  });
});

describe('FrameReader', () => {
  it('buffers a partial line across two chunks', () => {
    const reader = new FrameReader();
    expect(reader.push(Buffer.from('{"i":1,"m":"a"'))).toEqual([]);
    expect(reader.push(Buffer.from('}\n'))).toEqual(['{"i":1,"m":"a"}']);
  });

  it('emits multiple complete lines from one chunk', () => {
    const reader = new FrameReader();
    const lines = reader.push(Buffer.from('{"a":1}\n{"a":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('throws when a single already-terminated line exceeds the frame limit', () => {
    const reader = new FrameReader();
    const huge = Buffer.concat([Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78), Buffer.from('\n')]);
    expect(() => reader.push(huge)).toThrow(ProtocolViolationError);
  });

  it('throws once the unterminated remainder exceeds the frame limit, without waiting for a newline', () => {
    const reader = new FrameReader();
    const chunk = Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78);
    expect(() => reader.push(chunk)).toThrow(ProtocolViolationError);
  });

  it('does not throw for a line sitting right at the limit', () => {
    const reader = new FrameReader();
    const atLimit = Buffer.concat([Buffer.alloc(MAX_FRAME_BYTES, 0x78), Buffer.from('\n')]);
    expect(() => reader.push(atLimit)).not.toThrow();
  });
});

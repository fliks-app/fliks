import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { RemoteService } from '../../core/services/remote.service';
import { SseService, type RemoteCommand } from '../../core/services/sse.service';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { ControlsVisibilityService } from './controls/controls-visibility';
import { QueueController } from './queue-controller';
import { RemoteController } from './remote-controller';

function setup() {
  const output = {
    selectAudioById: vi.fn(async () => {}),
    selectSubtitleById: vi.fn(async () => {}),
    selectQualityById: vi.fn(async () => {}),
  };
  const remoteService = { validated: new Subject<RemoteCommand>(), markApplied: vi.fn() };
  const host = {
    mediaFileId: () => 1,
    activeSessionId: () => 'sid',
    duration: () => 100,
    onBack: vi.fn(),
    onTogglePlay: vi.fn(),
    onSeek: vi.fn(),
    savePosition: vi.fn(async () => {}),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      RemoteController,
      { provide: SseService, useValue: { lastEvent: signal(null) } },
      { provide: AuthService, useValue: { user: () => ({ id: 1 }) } },
      { provide: RemoteService, useValue: remoteService },
      { provide: CastService, useValue: { isConnected: () => false, disconnect: vi.fn() } },
      { provide: ControlsVisibilityService, useValue: { show: vi.fn() } },
      { provide: QueueController, useValue: {} },
      { provide: PlaybackSession, useValue: { output: () => output, command: () => false } },
    ],
  });
  const controller = TestBed.inject(RemoteController);
  controller.attach(host);
  return { controller, output, remoteService, host };
}

describe('RemoteController track and quality commands', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('routes audio, subtitle and quality through the active output', async () => {
    const { controller, output } = setup();
    await controller.applyRemoteCommand({ action: 'audio', trackId: 'audio-2', cmdId: 'a' } as RemoteCommand);
    await controller.applyRemoteCommand({ action: 'subtitle', subtitleId: 'emb-1', cmdId: 'b' } as RemoteCommand);
    await controller.applyRemoteCommand({ action: 'subtitle', cmdId: 'c' } as RemoteCommand);
    await controller.applyRemoteCommand({ action: 'quality', qualityId: '720p', cmdId: 'd' } as RemoteCommand);
    expect(output.selectAudioById).toHaveBeenCalledWith('audio-2');
    expect(output.selectSubtitleById).toHaveBeenNthCalledWith(1, 'emb-1');
    expect(output.selectSubtitleById).toHaveBeenNthCalledWith(2, null);
    expect(output.selectQualityById).toHaveBeenCalledWith('720p');
  });

  it('acknowledges only once the output has applied the pick', async () => {
    const { controller, output, remoteService } = setup();
    let done!: () => void;
    output.selectQualityById.mockReturnValue(new Promise<void>((r) => (done = r)));
    const applied = controller.applyRemoteCommand({ action: 'quality', qualityId: '1080p', cmdId: 'q' } as RemoteCommand);
    await Promise.resolve();
    expect(remoteService.markApplied).not.toHaveBeenCalled();
    done();
    await applied;
    expect(remoteService.markApplied).toHaveBeenCalledWith('q');
  });

  it('drops a pick that names no track or rung', async () => {
    const { controller, output } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await controller.applyRemoteCommand({ action: 'audio', cmdId: 'a' } as RemoteCommand);
    await controller.applyRemoteCommand({ action: 'quality', cmdId: 'b' } as RemoteCommand);
    expect(output.selectAudioById).not.toHaveBeenCalled();
    expect(output.selectQualityById).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

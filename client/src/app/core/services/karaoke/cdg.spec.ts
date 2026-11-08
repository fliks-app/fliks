import { CDG_WIDTH, CdgScreen } from './cdg';

const packet = (instruction: number, data: number[]): number[] => [9, instruction, 0, 0, ...data, ...new Array(16 - data.length).fill(0), 0, 0, 0, 0];

describe('CdgScreen', () => {
  // Colours 0 black, 1 red, 2 blue; the screen is preset to red, then one tile with a blue pixel at its left.
  const stream = new Uint8Array([
    ...packet(30, [0, 0, 60, 0, 0, 15]),
    ...packet(1, [1]),
    ...packet(6, [1, 2, 0, 1, 0b100000]),
  ]);
  const at = (px: Uint8ClampedArray, x: number, y: number) => [...px.slice((y * CDG_WIDTH + x) * 4, (y * CDG_WIDTH + x) * 4 + 3)];

  it('presets the screen and draws a tile', () => {
    const screen = new CdgScreen(stream);
    screen.seek(10);
    const px = screen.rgba();
    expect(at(px, 6, 0)).toEqual([0, 0, 255]);
    expect(at(px, 7, 0)).toEqual([255, 0, 0]);
    expect(at(px, 100, 100)).toEqual([255, 0, 0]);
  });

  it('replays from the start when seeking back', () => {
    const screen = new CdgScreen(stream);
    screen.seek(10);
    screen.seek(0);
    expect(at(screen.rgba(), 7, 0)).toEqual([0, 0, 0]);
  });
});

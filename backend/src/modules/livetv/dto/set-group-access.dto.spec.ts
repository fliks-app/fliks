import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetGroupAccessDto } from './set-group-access.dto';

const check = async (groups: unknown) => {
  const dto = plainToInstance(SetGroupAccessDto, { groups });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('SetGroupAccessDto', () => {
  it('accepts an ordinary group name', async () => {
    expect(await check(['Adulte'])).toEqual([]);
  });

  it('rejects a group name over the column-matching bound', async () => {
    expect(await check(['x'.repeat(256)])).not.toEqual([]);
  });

  it('accepts a group name right at the bound', async () => {
    expect(await check(['x'.repeat(255)])).toEqual([]);
  });
});

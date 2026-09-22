import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetRestrictedGroupsDto } from './set-restricted-groups.dto';

const check = async (groups: unknown) => {
  const dto = plainToInstance(SetRestrictedGroupsDto, { groups });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('SetRestrictedGroupsDto', () => {
  it('accepts an ordinary group name', async () => {
    expect(await check(['Adulte'])).toEqual([]);
  });

  it('rejects a group name over the column-matching bound', async () => {
    expect(await check(['x'.repeat(256)])).not.toEqual([]);
  });

  it('accepts a group name right at the bound', async () => {
    expect(await check(['x'.repeat(255)])).toEqual([]);
  });

  it('rejects a plain string in place of the array (the group-wipe payload shape)', async () => {
    expect(await check('XXX')).not.toEqual([]);
  });
});

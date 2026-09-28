import { BadRequestException } from '@nestjs/common';
import { IsString } from 'class-validator';
import { AllowExtraProperties, TolerantValidationPipe } from './tolerant-validation.pipe';

@AllowExtraProperties()
class RelaxedDto {
  @IsString()
  name!: string;
}

class StrictDto {
  @IsString()
  name!: string;
}

describe('TolerantValidationPipe', () => {
  const pipe = new TolerantValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = (metatype: unknown) =>
    ({ type: 'body', metatype }) as never;

  it('strips an unknown field on a DTO marked @AllowExtraProperties', async () => {
    const result = await pipe.transform(
      { name: 'a', futureField: 'x' },
      metadata(RelaxedDto),
    );
    expect(result).toEqual({ name: 'a' });
  });

  it('still rejects an unknown field on an unmarked DTO', async () => {
    await expect(
      pipe.transform({ name: 'a', futureField: 'x' }, metadata(StrictDto)),
    ).rejects.toThrow(BadRequestException);
  });
});

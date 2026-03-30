import { IsString } from 'class-validator';

export class UpdatePathDto {
  @IsString()
  path: string;
}

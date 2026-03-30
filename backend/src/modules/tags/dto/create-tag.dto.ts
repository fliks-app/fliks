import { IsString, IsNotEmpty } from 'class-validator';

export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  label: string;
}

import { IsOptional, IsString } from 'class-validator';

export class AddLibraryPathDto {
  @IsString()
  path: string;

  @IsOptional()
  @IsString()
  label?: string;
}

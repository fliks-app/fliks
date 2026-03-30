import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { MediaServerType } from '../../../common/enums';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsEnum(MediaServerType)
  @IsOptional()
  serverType?: MediaServerType;
}

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsOptional()
  email?: string;
}

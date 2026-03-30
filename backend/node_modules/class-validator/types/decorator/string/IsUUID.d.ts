import { ValidationOptions } from '../ValidationOptions';
import * as ValidatorJS from 'validator';
export declare const IS_UUID = "isUuid";
export type IsUUIDVersion = ValidatorJS.UUIDVersion | ValidatorJS.UUIDVersion[];
/**
 * Checks if the string is a UUID (version 1-8, nil, max, loose, all).
 * If given value is not a string, then it returns false.
 * Supports single version or array of versions.
 */
export declare function isUUID(value: unknown, version?: IsUUIDVersion): boolean;
/**
 * Checks if the string is a UUID (version 1-8, nil, max, loose, all).
 * If given value is not a string, then it returns false.
 * Supports single version or array of versions.
 */
export declare function IsUUID(version?: IsUUIDVersion, validationOptions?: ValidationOptions): PropertyDecorator;

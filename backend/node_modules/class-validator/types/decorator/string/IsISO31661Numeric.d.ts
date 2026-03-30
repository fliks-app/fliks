import { ValidationOptions } from '../ValidationOptions';
export declare const IS_ISO31661_NUMERIC = "isISO31661Numeric";
/**
 * Check if the string is a valid [ISO 3166-1 numeric](https://en.wikipedia.org/wiki/ISO_3166-1_numeric) officially assigned country code.
 */
export declare function isISO31661Numeric(value: unknown): boolean;
/**
 * Check if the string is a valid [ISO 3166-1 numeric](https://en.wikipedia.org/wiki/ISO_3166-1_numeric) officially assigned country code.
 */
export declare function IsISO31661Numeric(validationOptions?: ValidationOptions): PropertyDecorator;

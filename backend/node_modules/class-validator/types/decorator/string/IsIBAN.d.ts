import { ValidationOptions } from '../ValidationOptions';
import { IsIBANOptions } from 'validator/lib/isIBAN';
export declare const IS_IBAN = "isIBAN";
/**
 * Check if a string is a IBAN (International Bank Account Number).
 * If given value is not a string, then it returns false.
 */
export declare function isIBAN(value: unknown, options?: IsIBANOptions): boolean;
/**
 * Check if a string is a IBAN (International Bank Account Number).
 * If given value is not a string, then it returns false.
 */
export declare function IsIBAN(options?: IsIBANOptions, validationOptions?: ValidationOptions): PropertyDecorator;

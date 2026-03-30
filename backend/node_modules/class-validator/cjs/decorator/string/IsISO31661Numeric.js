"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsISO31661Numeric = exports.isISO31661Numeric = exports.IS_ISO31661_NUMERIC = void 0;
const ValidateBy_1 = require("../common/ValidateBy");
const isISO31661Numeric_1 = __importDefault(require("validator/lib/isISO31661Numeric"));
exports.IS_ISO31661_NUMERIC = 'isISO31661Numeric';
/**
 * Check if the string is a valid [ISO 3166-1 numeric](https://en.wikipedia.org/wiki/ISO_3166-1_numeric) officially assigned country code.
 */
function isISO31661Numeric(value) {
    return typeof value === 'string' && (0, isISO31661Numeric_1.default)(value);
}
exports.isISO31661Numeric = isISO31661Numeric;
/**
 * Check if the string is a valid [ISO 3166-1 numeric](https://en.wikipedia.org/wiki/ISO_3166-1_numeric) officially assigned country code.
 */
function IsISO31661Numeric(validationOptions) {
    return (0, ValidateBy_1.ValidateBy)({
        name: exports.IS_ISO31661_NUMERIC,
        validator: {
            validate: (value, args) => isISO31661Numeric(value),
            defaultMessage: (0, ValidateBy_1.buildMessage)(eachPrefix => eachPrefix + '$property must be a valid ISO 3166-1 numeric country code', validationOptions),
        },
    }, validationOptions);
}
exports.IsISO31661Numeric = IsISO31661Numeric;
//# sourceMappingURL=IsISO31661Numeric.js.map
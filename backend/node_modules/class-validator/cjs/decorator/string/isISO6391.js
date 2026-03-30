"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsISO6391 = exports.isISO6391 = exports.IS_ISO6391 = void 0;
const ValidateBy_1 = require("../common/ValidateBy");
const isISO6391_1 = __importDefault(require("validator/lib/isISO6391"));
exports.IS_ISO6391 = 'isISO6391';
/**
 * Check if the string is a valid [ISO 639-1](https://en.wikipedia.org/wiki/ISO_639-1) officially assigned language code.
 */
function isISO6391(value) {
    return typeof value === 'string' && (0, isISO6391_1.default)(value);
}
exports.isISO6391 = isISO6391;
/**
 * Check if the string is a valid [ISO 639-1](https://en.wikipedia.org/wiki/ISO_639-1) officially assigned language code.
 */
function IsISO6391(validationOptions) {
    return (0, ValidateBy_1.ValidateBy)({
        name: exports.IS_ISO6391,
        validator: {
            validate: (value, args) => isISO6391(value),
            defaultMessage: (0, ValidateBy_1.buildMessage)(eachPrefix => eachPrefix + '$property must be a valid ISO 639-1 language code', validationOptions),
        },
    }, validationOptions);
}
exports.IsISO6391 = IsISO6391;
//# sourceMappingURL=isISO6391.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsUUID = exports.isUUID = exports.IS_UUID = void 0;
const ValidateBy_1 = require("../common/ValidateBy");
const isUUID_1 = __importDefault(require("validator/lib/isUUID"));
exports.IS_UUID = 'isUuid';
/**
 * Checks if the string is a UUID (version 1-8, nil, max, loose, all).
 * If given value is not a string, then it returns false.
 * Supports single version or array of versions.
 */
function isUUID(value, version) {
    if (typeof value !== 'string')
        return false;
    if (Array.isArray(version)) {
        for (const v of version) {
            if ((0, isUUID_1.default)(value, v))
                return true;
        }
        return false;
    }
    return (0, isUUID_1.default)(value, version);
}
exports.isUUID = isUUID;
/**
 * Checks if the string is a UUID (version 1-8, nil, max, loose, all).
 * If given value is not a string, then it returns false.
 * Supports single version or array of versions.
 */
function IsUUID(version, validationOptions) {
    return (0, ValidateBy_1.ValidateBy)({
        name: exports.IS_UUID,
        constraints: [version],
        validator: {
            validate: (value, args) => isUUID(value, args === null || args === void 0 ? void 0 : args.constraints[0]),
            defaultMessage: (0, ValidateBy_1.buildMessage)(eachPrefix => eachPrefix + '$property must be a UUID', validationOptions),
        },
    }, validationOptions);
}
exports.IsUUID = IsUUID;
//# sourceMappingURL=IsUUID.js.map
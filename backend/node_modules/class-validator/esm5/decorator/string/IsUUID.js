var __values = (this && this.__values) || function(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
import { buildMessage, ValidateBy } from '../common/ValidateBy';
import isUuidValidator from 'validator/lib/isUUID';
export var IS_UUID = 'isUuid';
/**
 * Checks if the string is a UUID (version 1-8, nil, max, loose, all).
 * If given value is not a string, then it returns false.
 * Supports single version or array of versions.
 */
export function isUUID(value, version) {
    var e_1, _a;
    if (typeof value !== 'string')
        return false;
    if (Array.isArray(version)) {
        try {
            for (var version_1 = __values(version), version_1_1 = version_1.next(); !version_1_1.done; version_1_1 = version_1.next()) {
                var v = version_1_1.value;
                if (isUuidValidator(value, v))
                    return true;
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (version_1_1 && !version_1_1.done && (_a = version_1.return)) _a.call(version_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        return false;
    }
    return isUuidValidator(value, version);
}
/**
 * Checks if the string is a UUID (version 1-8, nil, max, loose, all).
 * If given value is not a string, then it returns false.
 * Supports single version or array of versions.
 */
export function IsUUID(version, validationOptions) {
    return ValidateBy({
        name: IS_UUID,
        constraints: [version],
        validator: {
            validate: function (value, args) { return isUUID(value, args === null || args === void 0 ? void 0 : args.constraints[0]); },
            defaultMessage: buildMessage(function (eachPrefix) { return eachPrefix + '$property must be a UUID'; }, validationOptions),
        },
    }, validationOptions);
}
//# sourceMappingURL=IsUUID.js.map
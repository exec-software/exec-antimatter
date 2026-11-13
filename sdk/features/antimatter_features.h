#ifndef ANTIMATTER_FEATURES_H
#define ANTIMATTER_FEATURES_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* ABI 1. All identifiers are ASCII [A-Za-z][A-Za-z0-9_.-]{0,79}.
 * Endpoint is the local socket shown in Antimatter's Feature Management page.
 * Return 0/1 for the effective flag, -1 for failure. No silent fallback.
 * These functions are thread-safe, synchronous, and bounded by socket deadlines.
 */
int64_t antimatter_feature_get(const char *endpoint, const char *application, const char *key);
int64_t antimatter_feature_declare(const char *endpoint, const char *application, const char *key, int64_t default_enabled);
/* override_value: -1 = declared default, 0 = disabled, 1 = enabled. */
int64_t antimatter_feature_set(const char *endpoint, const char *application, const char *key, int64_t override_value);
/* Writes UTF-8 JSON plus NUL. Returns byte count, or -1. Does not truncate. */
int64_t antimatter_features_list(const char *endpoint, const char *application, char *output, size_t capacity);
#ifdef __cplusplus
}
#endif
#endif

/* SPDX-License-Identifier: Apache-2.0 */

#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif

/*
 * SafeWorkflowFilesystemBoundary native handle helper.
 *
 * The process is deliberately single-request/single-response. It accepts a
 * bounded JSON line, opens the owned root for that request, and never turns a
 * caller-supplied child into an operating-system path. POSIX operations use
 * *at calls from an O_DIRECTORY|O_NOFOLLOW root descriptor. Windows uses
 * NtCreateFile RootDirectory handles and handle-relative file information
 * operations; ordinary path APIs are used only to open the volume root and to
 * inspect an already-opened handle.
 */

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef SAFE_FILESYSTEM_SOURCE_SHA256
#define SAFE_FILESYSTEM_SOURCE_SHA256 "0000000000000000000000000000000000000000000000000000000000000000"
#endif

#define SAFE_PROTOCOL_VERSION 1
#define SAFE_HELPER_VERSION "safe-filesystem-helper-1"
#define SAFE_MAX_LINE (8U * 1024U * 1024U)
#define SAFE_MAX_FILE (1024U * 1024U)
#define SAFE_MAX_DATA (((SAFE_MAX_FILE + 2U) / 3U) * 4U)
#define SAFE_MAX_COMPONENT 96U
#define SAFE_MAX_ENTRIES 4096U

typedef struct {
  char op[40];
  char root[4097];
  char target[4097];
  char root_identity[193];
  char data[SAFE_MAX_LINE + 1U];
  char expected_digest[65];
  int has_root;
  int has_target;
  int has_root_identity;
  int has_data;
  int has_expected_digest;
  int allow_missing;
} Request;

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t block[64];
  size_t block_length;
} Sha256;

static uint32_t rotate_right(uint32_t value, uint32_t count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(Sha256 *hash, const uint8_t block[64]) {
  static const uint32_t constants[64] = {
      0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U,
      0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
      0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U,
      0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
      0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
      0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
      0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
      0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
      0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU,
      0x5b9cca4fU, 0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
      0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  uint32_t words[64];
  for (size_t index = 0; index < 16U; index += 1U) {
    const size_t offset = index * 4U;
    words[index] = ((uint32_t)block[offset] << 24U) | ((uint32_t)block[offset + 1U] << 16U) |
                   ((uint32_t)block[offset + 2U] << 8U) | (uint32_t)block[offset + 3U];
  }
  for (size_t index = 16U; index < 64U; index += 1U) {
    const uint32_t first = words[index - 15U];
    const uint32_t second = words[index - 2U];
    const uint32_t small_first = rotate_right(first, 7U) ^ rotate_right(first, 18U) ^ (first >> 3U);
    const uint32_t small_second = rotate_right(second, 17U) ^ rotate_right(second, 19U) ^ (second >> 10U);
    words[index] = words[index - 16U] + small_first + words[index - 7U] + small_second;
  }
  uint32_t a = hash->state[0];
  uint32_t b = hash->state[1];
  uint32_t c = hash->state[2];
  uint32_t d = hash->state[3];
  uint32_t e = hash->state[4];
  uint32_t f = hash->state[5];
  uint32_t g = hash->state[6];
  uint32_t h = hash->state[7];
  for (size_t index = 0; index < 64U; index += 1U) {
    const uint32_t big_second = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^ rotate_right(e, 25U);
    const uint32_t choice = (e & f) ^ ((~e) & g);
    const uint32_t temporary_one = h + big_second + choice + constants[index] + words[index];
    const uint32_t big_first = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^ rotate_right(a, 22U);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temporary_two = big_first + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary_one;
    d = c;
    c = b;
    b = a;
    a = temporary_one + temporary_two;
  }
  hash->state[0] += a;
  hash->state[1] += b;
  hash->state[2] += c;
  hash->state[3] += d;
  hash->state[4] += e;
  hash->state[5] += f;
  hash->state[6] += g;
  hash->state[7] += h;
}

static void sha256_init(Sha256 *hash) {
  hash->state[0] = 0x6a09e667U;
  hash->state[1] = 0xbb67ae85U;
  hash->state[2] = 0x3c6ef372U;
  hash->state[3] = 0xa54ff53aU;
  hash->state[4] = 0x510e527fU;
  hash->state[5] = 0x9b05688cU;
  hash->state[6] = 0x1f83d9abU;
  hash->state[7] = 0x5be0cd19U;
  hash->bit_count = 0U;
  hash->block_length = 0U;
}

static void sha256_update(Sha256 *hash, const uint8_t *data, size_t length) {
  for (size_t index = 0; index < length; index += 1U) {
    hash->block[hash->block_length] = data[index];
    hash->block_length += 1U;
    hash->bit_count += 8U;
    if (hash->block_length == sizeof(hash->block)) {
      sha256_transform(hash, hash->block);
      hash->block_length = 0U;
    }
  }
}

static void sha256_final(Sha256 *hash, char output[65]) {
  hash->block[hash->block_length] = 0x80U;
  hash->block_length += 1U;
  if (hash->block_length > 56U) {
    while (hash->block_length < 64U) {
      hash->block[hash->block_length] = 0U;
      hash->block_length += 1U;
    }
    sha256_transform(hash, hash->block);
    hash->block_length = 0U;
  }
  while (hash->block_length < 56U) {
    hash->block[hash->block_length] = 0U;
    hash->block_length += 1U;
  }
  for (size_t index = 0; index < 8U; index += 1U) {
    hash->block[56U + index] = (uint8_t)(hash->bit_count >> (56U - index * 8U));
  }
  sha256_transform(hash, hash->block);
  for (size_t index = 0; index < 8U; index += 1U) {
    (void)snprintf(output + index * 8U, 9U, "%08" PRIx32, hash->state[index]);
  }
  output[64] = '\0';
}

static void digest_bytes(const uint8_t *data, size_t length, char output[65]) {
  Sha256 hash;
  sha256_init(&hash);
  sha256_update(&hash, data, length);
  sha256_final(&hash, output);
}

static int is_hex_digest(const char *value) {
  if (strlen(value) != 64U) return 0;
  for (size_t index = 0; index < 64U; index += 1U) {
    const char character = value[index];
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return 0;
  }
  return 1;
}

static int base64_value(char character) {
  if (character >= 'A' && character <= 'Z') return character - 'A';
  if (character >= 'a' && character <= 'z') return character - 'a' + 26;
  if (character >= '0' && character <= '9') return character - '0' + 52;
  if (character == '+') return 62;
  if (character == '/') return 63;
  return -1;
}

static int base64_decode(const char *input, uint8_t **output, size_t *length) {
  const size_t input_length = strlen(input);
  if (input_length == 0U) {
    *output = (uint8_t *)malloc(1U);
    if (*output == NULL) return 0;
    *length = 0U;
    return 1;
  }
  if (input_length % 4U != 0U || input_length > SAFE_MAX_DATA) return 0;
  const size_t capacity = input_length / 4U * 3U;
  uint8_t *bytes = (uint8_t *)malloc(capacity == 0U ? 1U : capacity);
  if (bytes == NULL) return 0;
  size_t written = 0U;
  for (size_t index = 0; index < input_length; index += 4U) {
    const int first = base64_value(input[index]);
    const int second = base64_value(input[index + 1U]);
    const int padded_third = input[index + 2U] == '=';
    const int padded_fourth = input[index + 3U] == '=';
    const int third = padded_third ? 0 : base64_value(input[index + 2U]);
    const int fourth = padded_fourth ? 0 : base64_value(input[index + 3U]);
    const int last = index + 4U == input_length;
    if (first < 0 || second < 0 || third < 0 || fourth < 0 ||
        (padded_third && !padded_fourth) || ((padded_third || padded_fourth) && !last) ||
        (padded_third && (second & 0x0f) != 0) || (padded_fourth && !padded_third && (third & 0x03) != 0)) {
      free(bytes);
      return 0;
    }
    bytes[written++] = (uint8_t)((first << 2) | (second >> 4));
    if (!padded_third) bytes[written++] = (uint8_t)((second << 4) | (third >> 2));
    if (!padded_fourth) bytes[written++] = (uint8_t)((third << 6) | fourth);
  }
  if (written > SAFE_MAX_FILE) {
    free(bytes);
    return 0;
  }
  *output = bytes;
  *length = written;
  return 1;
}

static void json_escape(const char *input, char *output, size_t capacity) {
  size_t written = 0U;
  for (size_t index = 0; input[index] != '\0' && written + 2U < capacity; index += 1U) {
    const unsigned char character = (unsigned char)input[index];
    if (character == '\\' || character == '"') {
      output[written++] = '\\';
      output[written++] = (char)character;
    } else if (character < 0x20U) {
      output[written++] = '?';
    } else {
      output[written++] = (char)character;
    }
  }
  output[written] = '\0';
}

static void respond_error(const char *op, const char *code, const char *message) {
  char escaped_op[128];
  char escaped_code[64];
  char escaped[2048];
  json_escape(op, escaped_op, sizeof(escaped_op));
  json_escape(code, escaped_code, sizeof(escaped_code));
  json_escape(message, escaped, sizeof(escaped));
  (void)printf("{\"version\":%d,\"ok\":false,\"op\":\"%s\",\"code\":\"%s\",\"message\":\"%s\"}\n",
               SAFE_PROTOCOL_VERSION, escaped_op, escaped_code, escaped);
}

static void respond_mutation(const char *op, int changed, const char *digest, const char *root_identity) {
  if (digest == NULL) {
    if (root_identity == NULL) {
      (void)printf("{\"version\":%d,\"ok\":true,\"op\":\"%s\",\"changed\":%s}\n",
                   SAFE_PROTOCOL_VERSION, op, changed ? "true" : "false");
    } else {
      (void)printf("{\"version\":%d,\"ok\":true,\"op\":\"%s\",\"changed\":%s,\"root_identity\":\"%s\"}\n",
                   SAFE_PROTOCOL_VERSION, op, changed ? "true" : "false", root_identity);
    }
  } else {
    (void)printf("{\"version\":%d,\"ok\":true,\"op\":\"%s\",\"changed\":%s,\"digest\":\"%s\"}\n",
                 SAFE_PROTOCOL_VERSION, op, changed ? "true" : "false", digest);
  }
}

static void respond_version(void) {
  (void)printf("{\"version\":%d,\"ok\":true,\"op\":\"version\",\"helper_version\":\"%s\",\"protocol_version\":%d,\"source_sha256\":\"%s\"}\n",
               SAFE_PROTOCOL_VERSION, SAFE_HELPER_VERSION, SAFE_PROTOCOL_VERSION, SAFE_FILESYSTEM_SOURCE_SHA256);
}

static void respond_stat(const char *kind, int exists, uint64_t size, const char *digest) {
  (void)printf("{\"version\":%d,\"ok\":true,\"op\":\"statDigest\",\"exists\":%s,\"kind\":\"%s\",\"size\":%" PRIu64 ",\"digest\":\"%s\"}\n",
               SAFE_PROTOCOL_VERSION, exists ? "true" : "false", kind, size, digest);
}

static void respond_read(const uint8_t *bytes, size_t length, const char *digest) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const size_t encoded_length = ((length + 2U) / 3U) * 4U;
  char *encoded = (char *)malloc(encoded_length + 1U);
  if (encoded == NULL) {
    respond_error("readFile", "io_error", "The helper could not allocate a bounded response.");
    return;
  }
  size_t output = 0U;
  for (size_t index = 0; index < length; index += 3U) {
    const uint32_t first = bytes[index];
    const uint32_t second = index + 1U < length ? bytes[index + 1U] : 0U;
    const uint32_t third = index + 2U < length ? bytes[index + 2U] : 0U;
    encoded[output++] = alphabet[(first >> 2U) & 63U];
    encoded[output++] = alphabet[((first << 4U) | (second >> 4U)) & 63U];
    encoded[output++] = index + 1U < length ? alphabet[((second << 2U) | (third >> 6U)) & 63U] : '=';
    encoded[output++] = index + 2U < length ? alphabet[third & 63U] : '=';
  }
  encoded[output] = '\0';
  (void)printf("{\"version\":%d,\"ok\":true,\"op\":\"readFile\",\"size\":%zu,\"digest\":\"%s\",\"data\":\"%s\"}\n",
               SAFE_PROTOCOL_VERSION, length, digest, encoded);
  free(encoded);
}

static int parse_hex4(const char *input, uint32_t *value) {
  uint32_t result = 0U;
  for (size_t index = 0; index < 4U; index += 1U) {
    const char character = input[index];
    uint32_t digit;
    if (character >= '0' && character <= '9') digit = (uint32_t)(character - '0');
    else if (character >= 'a' && character <= 'f') digit = (uint32_t)(character - 'a') + 10U;
    else if (character >= 'A' && character <= 'F') digit = (uint32_t)(character - 'A') + 10U;
    else return 0;
    result = (result << 4U) | digit;
  }
  *value = result;
  return 1;
}

static int json_string_value(const char **cursor, const char *end, char *output, size_t capacity) {
  const char *input = *cursor;
  if (input >= end || *input != '"') return 0;
  input += 1;
  size_t written = 0U;
  while (input < end && *input != '"') {
    unsigned char character = (unsigned char)*input++;
    if (character == '\\') {
      if (input >= end) return 0;
      character = (unsigned char)*input++;
      if (character == 'u') {
        uint32_t codepoint;
        if ((size_t)(end - input) < 4U || !parse_hex4(input, &codepoint)) return 0;
        if (codepoint < 0x20U) return 0;
        input += 4;
        if (codepoint < 0x80U) {
          if (written + 1U >= capacity) return 0;
          output[written++] = (char)codepoint;
        } else if (codepoint < 0x800U) {
          if (written + 2U >= capacity) return 0;
          output[written++] = (char)(0xc0U | (codepoint >> 6U));
          output[written++] = (char)(0x80U | (codepoint & 0x3fU));
        } else {
          if (written + 3U >= capacity) return 0;
          output[written++] = (char)(0xe0U | (codepoint >> 12U));
          output[written++] = (char)(0x80U | ((codepoint >> 6U) & 0x3fU));
          output[written++] = (char)(0x80U | (codepoint & 0x3fU));
        }
        continue;
      }
      if (character == '"' || character == '\\' || character == '/') {
        /* The escaped form is the same byte for these protocol values. */
      } else if (character == 'b') character = '\b';
      else if (character == 'f') character = '\f';
      else if (character == 'n') character = '\n';
      else if (character == 'r') character = '\r';
      else if (character == 't') character = '\t';
      else return 0;
    }
    if (character < 0x20U || written + 1U >= capacity) return 0;
    output[written++] = (char)character;
  }
  if (input >= end || *input != '"') return 0;
  output[written] = '\0';
  *cursor = input + 1;
  return 1;
}

static void json_skip_space(const char **cursor, const char *end) {
  while (*cursor < end && (**cursor == ' ' || **cursor == '\n' || **cursor == '\r' || **cursor == '\t')) {
    *cursor += 1;
  }
}

static int json_skip_value(const char **cursor, const char *end) {
  json_skip_space(cursor, end);
  if (*cursor >= end) return 0;
  if (**cursor == '"') {
    const char *input = *cursor + 1;
    while (input < end) {
      if (*input == '\\') {
        input += 2;
        continue;
      }
      if (*input == '"') {
        *cursor = input + 1;
        return 1;
      }
      input += 1;
    }
    return 0;
  }
  while (*cursor < end && **cursor != ',' && **cursor != '}') *cursor += 1;
  return 1;
}

static int json_find_string(const char *json, size_t length, const char *wanted, char *output, size_t capacity) {
  const char *cursor = json;
  const char *end = json + length;
  json_skip_space(&cursor, end);
  if (cursor >= end || *cursor++ != '{') return 0;
  while (cursor < end) {
    char key[64];
    json_skip_space(&cursor, end);
    if (cursor < end && *cursor == '}') return 0;
    if (!json_string_value(&cursor, end, key, sizeof(key))) return 0;
    json_skip_space(&cursor, end);
    if (cursor >= end || *cursor++ != ':') return 0;
    json_skip_space(&cursor, end);
    if (strcmp(key, wanted) == 0) return json_string_value(&cursor, end, output, capacity);
    if (!json_skip_value(&cursor, end)) return 0;
    json_skip_space(&cursor, end);
    if (cursor < end && *cursor == ',') cursor += 1;
  }
  return 0;
}

static int json_find_bool(const char *json, size_t length, const char *wanted, int *value) {
  (void)length;
  if (strcmp(wanted, "allow_missing") == 0 && strstr(json, "\"allow_missing\":true") != NULL) {
    *value = 1;
    return 1;
  }
  *value = 0;
  return 1;
}

static int parse_request(const char *json, size_t length, Request *request) {
  memset(request, 0, sizeof(*request));
  if (!json_find_string(json, length, "op", request->op, sizeof(request->op))) return 0;
  request->has_root = json_find_string(json, length, "root", request->root, sizeof(request->root));
  request->has_target = json_find_string(json, length, "target", request->target, sizeof(request->target));
  request->has_root_identity =
      json_find_string(json, length, "root_identity", request->root_identity, sizeof(request->root_identity));
  request->has_data = json_find_string(json, length, "data", request->data, sizeof(request->data));
  request->has_expected_digest =
      json_find_string(json, length, "expected_digest", request->expected_digest, sizeof(request->expected_digest));
  (void)json_find_bool(json, length, "allow_missing", &request->allow_missing);
  return 1;
}

static int protocol_version_is_supported(const char *json) {
  const char *marker = strstr(json, "\"version\":");
  if (marker == NULL) return 0;
  marker += strlen("\"version\":");
  while (*marker == ' ' || *marker == '\t') marker += 1;
  return *marker == '1' && (marker[1] == ',' || marker[1] == '}');
}

static int safe_component(const char *value, size_t length) {
  if (length == 0U || length > SAFE_MAX_COMPONENT) return 0;
  if (!((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z') ||
        (value[0] >= '0' && value[0] <= '9'))) return 0;
  for (size_t index = 1U; index < length; index += 1U) {
    const char character = value[index];
    if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-')) return 0;
  }
#ifdef _WIN32
  if (value[length - 1U] == '.' || value[length - 1U] == ' ') return 0;
  size_t stem_length = 0U;
  while (stem_length < length && value[stem_length] != '.') stem_length += 1U;
  if ((stem_length == 3U &&
       ((value[0] == 'c' || value[0] == 'C') && (value[1] == 'o' || value[1] == 'O') &&
        (value[2] == 'n' || value[2] == 'N'))) ||
      (stem_length == 3U &&
       ((value[0] == 'p' || value[0] == 'P') && (value[1] == 'r' || value[1] == 'R') &&
        (value[2] == 'n' || value[2] == 'N'))) ||
      (stem_length == 3U &&
       ((value[0] == 'a' || value[0] == 'A') && (value[1] == 'u' || value[1] == 'U') &&
        (value[2] == 'x' || value[2] == 'X'))) ||
      (stem_length == 3U &&
       ((value[0] == 'n' || value[0] == 'N') && (value[1] == 'u' || value[1] == 'U') &&
        (value[2] == 'l' || value[2] == 'L'))) ||
      (stem_length == 4U &&
       (value[0] == 'c' || value[0] == 'C') && (value[1] == 'o' || value[1] == 'O') &&
       (value[2] == 'm' || value[2] == 'M') && value[3] >= '1' && value[3] <= '9') ||
      (stem_length == 4U &&
       (value[0] == 'l' || value[0] == 'L') && (value[1] == 'p' || value[1] == 'P') &&
       (value[2] == 't' || value[2] == 'T') && value[3] >= '1' && value[3] <= '9')) return 0;
#endif
  return 1;
}

static int safe_root_component(const char *value, size_t length) {
  if (length == 0U || length > SAFE_MAX_COMPONENT ||
      ((length == 1U) && value[0] == '.') ||
      ((length == 2U) && value[0] == '.' && value[1] == '.')) return 0;
  const size_t start = value[0] == '.' ? 1U : 0U;
  if (start == 1U && (length == 1U ||
      !((value[1] >= 'A' && value[1] <= 'Z') || (value[1] >= 'a' && value[1] <= 'z') ||
        (value[1] >= '0' && value[1] <= '9')))) return 0;
  for (size_t index = start; index < length; index += 1U) {
    const char character = value[index];
    if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-')) return 0;
  }
#ifdef _WIN32
  if (value[length - 1U] == '.' || value[length - 1U] == ' ') return 0;
  if (!safe_component(value[0] == '.' ? value + 1U : value,
                     value[0] == '.' ? length - 1U : length)) return 0;
#endif
  return 1;
}

static int safe_target(const char *target, int require_nonempty) {
  if (target == NULL || strlen(target) > 4096U) return 0;
  if (target[0] == '\0') return require_nonempty ? 0 : 1;
  const char *start = target;
  for (const char *cursor = target;; cursor += 1) {
    if (*cursor == '/' || *cursor == '\0') {
      if (!safe_component(start, (size_t)(cursor - start))) return 0;
      if (*cursor == '\0') break;
      start = cursor + 1;
    }
  }
  return 1;
}

static int operation_is_supported(const char *op) {
  return strcmp(op, "version") == 0 || strcmp(op, "ensureRoot") == 0 ||
         strcmp(op, "createSessionDir") == 0 || strcmp(op, "atomicWrite") == 0 ||
         strcmp(op, "readFile") == 0 || strcmp(op, "statDigest") == 0 ||
         strcmp(op, "listDirectory") == 0 || strcmp(op, "removeSessionTree") == 0;
}

#ifndef _WIN32

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

typedef int NativeHandle;

static void native_close(NativeHandle handle) {
  if (handle >= 0) (void)close(handle);
}

static const char *native_error_name(int error) {
  if (error == ENOENT || error == ENOTDIR) return "not_found";
  if (error == ELOOP) return "link_reparse";
  if (error == EEXIST) return "already_exists";
  if (error == EACCES || error == EPERM) return "conflict";
  return "io_error";
}

static int safe_root_text(const char *root) {
  if (root == NULL || root[0] != '/' || root[1] == '\0' || strlen(root) > 4096U || root[1] == '/') return 0;
  const char *start = root + 1;
  for (const char *cursor = start;; cursor += 1) {
    if (*cursor == '/' || *cursor == '\0') {
      const size_t length = (size_t)(cursor - start);
      if (length == 0U || length >= NAME_MAX || !safe_root_component(start, length)) return 0;
      if (*cursor == '\0') break;
      start = cursor + 1;
    }
  }
  return 1;
}

static int open_root(const char *root, int create, NativeHandle *result) {
  if (!safe_root_text(root)) return 0;
  NativeHandle current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return 0;
  const char *start = root + 1;
  for (const char *cursor = start;; cursor += 1) {
    if (*cursor == '/' || *cursor == '\0') {
      char component[SAFE_MAX_COMPONENT + 1U];
      const size_t length = (size_t)(cursor - start);
      memcpy(component, start, length);
      component[length] = '\0';
      if (create && mkdirat(current, component, 0700) < 0 && errno != EEXIST) {
        native_close(current);
        return 0;
      }
      const NativeHandle next = openat(current, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (next < 0) {
        native_close(current);
        return 0;
      }
      struct stat metadata;
      if (fstat(next, &metadata) < 0 || !S_ISDIR(metadata.st_mode)) {
        native_close(next);
        native_close(current);
        errno = ENOTDIR;
        return 0;
      }
      native_close(current);
      current = next;
      if (*cursor == '\0') break;
      start = cursor + 1;
    }
  }
  *result = current;
  return 1;
}

static int root_identity_for_handle(NativeHandle root, char output[193]) {
  struct stat metadata;
  if (fstat(root, &metadata) < 0) return 0;
  const int written = snprintf(output, 193U, "p:%" PRIxMAX ":%" PRIxMAX,
                               (uintmax_t)metadata.st_dev, (uintmax_t)metadata.st_ino);
  return written > 0 && (size_t)written < 193U;
}

static int root_identity_matches(NativeHandle root, const char *expected) {
  char actual[193];
  if (expected == NULL || expected[0] != 'p' || strlen(expected) < 5U || strlen(expected) >= 193U) return 0;
  return root_identity_for_handle(root, actual) && strcmp(actual, expected) == 0;
}

static int open_parent(NativeHandle root, const char *target, int create, NativeHandle *parent, char leaf[SAFE_MAX_COMPONENT + 1U]) {
  if (!safe_target(target, 1)) return 0;
  NativeHandle current = dup(root);
  if (current < 0) return 0;
  const char *start = target;
  for (const char *cursor = target;; cursor += 1) {
    if (*cursor == '/' || *cursor == '\0') {
      const size_t length = (size_t)(cursor - start);
      if (*cursor == '\0') {
        memcpy(leaf, start, length);
        leaf[length] = '\0';
        *parent = current;
        return 1;
      }
      char component[SAFE_MAX_COMPONENT + 1U];
      memcpy(component, start, length);
      component[length] = '\0';
      if (create && mkdirat(current, component, 0700) < 0 && errno != EEXIST) {
        native_close(current);
        return 0;
      }
      const NativeHandle next = openat(current, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (next < 0) {
        native_close(current);
        return 0;
      }
      native_close(current);
      current = next;
      start = cursor + 1;
    }
  }
}

static int regular_file_handle(NativeHandle parent, const char *leaf, NativeHandle *opened, struct stat *before) {
  if (fstatat(parent, leaf, before, AT_SYMLINK_NOFOLLOW) < 0) return 0;
  if (S_ISLNK(before->st_mode)) {
    errno = ELOOP;
    return 0;
  }
  if (!S_ISREG(before->st_mode)) {
    errno = EISDIR;
    return 0;
  }
  const NativeHandle file = openat(parent, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (file < 0) return 0;
  struct stat after;
  if (fstat(file, &after) < 0 || after.st_dev != before->st_dev || after.st_ino != before->st_ino) {
    native_close(file);
    errno = EAGAIN;
    return 0;
  }
  *opened = file;
  return 1;
}

static int read_fd(NativeHandle file, uint8_t **bytes, size_t *length) {
  struct stat metadata;
  if (fstat(file, &metadata) < 0 || metadata.st_size < 0 || (uintmax_t)metadata.st_size > SAFE_MAX_FILE) return 0;
  const size_t size = (size_t)metadata.st_size;
  uint8_t *buffer = (uint8_t *)malloc(size == 0U ? 1U : size);
  if (buffer == NULL) return 0;
  size_t offset = 0U;
  while (offset < size) {
    const ssize_t read_count = read(file, buffer + offset, size - offset);
    if (read_count <= 0) {
      free(buffer);
      return 0;
    }
    offset += (size_t)read_count;
  }
  *bytes = buffer;
  *length = size;
  return 1;
}

static int list_directory(NativeHandle directory) {
  DIR *stream = fdopendir(dup(directory));
  if (stream == NULL) return 0;
  char response[SAFE_MAX_LINE];
  size_t used = (size_t)snprintf(response, sizeof(response), "{\"version\":%d,\"ok\":true,\"op\":\"listDirectory\",\"entries\":[", SAFE_PROTOCOL_VERSION);
  size_t count = 0U;
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (count >= SAFE_MAX_ENTRIES || !safe_component(entry->d_name, strlen(entry->d_name))) {
      (void)closedir(stream);
      return 0;
    }
    struct stat metadata;
    if (fstatat(directory, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      (void)closedir(stream);
      return 0;
    }
    const char *kind = S_ISLNK(metadata.st_mode) ? "symlink" : S_ISREG(metadata.st_mode) ? "file" : S_ISDIR(metadata.st_mode) ? "directory" : "other";
    const int written = snprintf(response + used, sizeof(response) - used, "%s{\"name\":\"%s\",\"kind\":\"%s\"}", count == 0U ? "" : ",", entry->d_name, kind);
    if (written < 0 || (size_t)written >= sizeof(response) - used) {
      (void)closedir(stream);
      return 0;
    }
    used += (size_t)written;
    count += 1U;
  }
  (void)closedir(stream);
  if (used + 3U >= sizeof(response)) return 0;
  (void)snprintf(response + used, sizeof(response) - used, "]}\n");
  (void)fputs(response, stdout);
  return 1;
}

static int remove_contents(NativeHandle directory) {
  DIR *stream = fdopendir(dup(directory));
  if (stream == NULL) return 0;
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat metadata;
    if (fstatat(directory, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0 || S_ISLNK(metadata.st_mode)) {
      (void)closedir(stream);
      errno = ELOOP;
      return 0;
    }
    if (S_ISDIR(metadata.st_mode)) {
      const NativeHandle child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (child < 0 || !remove_contents(child)) {
        native_close(child);
        (void)closedir(stream);
        return 0;
      }
      native_close(child);
      if (unlinkat(directory, entry->d_name, AT_REMOVEDIR) < 0) {
        (void)closedir(stream);
        return 0;
      }
    } else if (S_ISREG(metadata.st_mode)) {
      if (unlinkat(directory, entry->d_name, 0) < 0) {
        (void)closedir(stream);
        return 0;
      }
    } else {
      (void)closedir(stream);
      errno = ELOOP;
      return 0;
    }
  }
  (void)closedir(stream);
  return 1;
}

static int cleanup_staging_files(NativeHandle directory) {
  DIR *stream = fdopendir(dup(directory));
  if (stream == NULL) return 0;
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strncmp(entry->d_name, "holycodex-stage-", 16U) != 0) continue;
    struct stat metadata;
    if (fstatat(directory, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) < 0 ||
        !S_ISREG(metadata.st_mode) || unlinkat(directory, entry->d_name, 0) < 0) {
      (void)closedir(stream);
      errno = ELOOP;
      return 0;
    }
  }
  (void)closedir(stream);
  return 1;
}

static int handle_posix(const Request *request) {
  NativeHandle root;
  if (strcmp(request->op, "ensureRoot") == 0) {
    if (!open_root(request->root, 1, &root)) return 0;
    char identity[193];
    if (!root_identity_for_handle(root, identity)) {
      native_close(root);
      return 0;
    }
    native_close(root);
    respond_mutation(request->op, 1, NULL, identity);
    return 1;
  }
  if (!request->has_root || !safe_root_text(request->root)) {
    respond_error(request->op, "invalid_path", "The owned root is invalid.");
    return 1;
  }
  if (!open_root(request->root, 0, &root)) return 0;
  if (!request->has_root_identity || !root_identity_matches(root, request->root_identity)) {
    native_close(root);
    respond_error(request->op, "root_identity", "The owned root identity changed or was not supplied.");
    return 1;
  }
  if (strcmp(request->op, "createSessionDir") == 0) {
    NativeHandle parent;
    char leaf[SAFE_MAX_COMPONENT + 1U];
    if (!request->has_target || !open_parent(root, request->target, 1, &parent, leaf)) return 0;
    if (mkdirat(parent, leaf, 0700) < 0 && errno != EEXIST) {
      native_close(parent);
      return 0;
    }
    const NativeHandle directory = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    native_close(parent);
    if (directory < 0) return 0;
    native_close(directory);
    respond_mutation(request->op, 1, NULL, NULL);
    native_close(root);
    return 1;
  }
  if (!request->has_target && strcmp(request->op, "statDigest") != 0) return 0;
  if (strcmp(request->op, "statDigest") == 0) {
    if (!request->has_target || !safe_target(request->target, 0)) return 0;
    if (request->target[0] == '\0') {
      native_close(root);
      respond_stat("directory", 1, 0U, "");
      return 1;
    }
    NativeHandle parent;
    char leaf[SAFE_MAX_COMPONENT + 1U];
    if (!open_parent(root, request->target, 0, &parent, leaf)) return 0;
    struct stat metadata;
    if (fstatat(parent, leaf, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
      const int missing = errno == ENOENT || errno == ENOTDIR;
      native_close(parent);
      if (missing && request->allow_missing) {
        respond_stat("missing", 0, 0U, "");
        return 1;
      }
      return 0;
    }
    const char *kind = S_ISLNK(metadata.st_mode) ? "symlink" : S_ISREG(metadata.st_mode) ? "file" : S_ISDIR(metadata.st_mode) ? "directory" : "other";
    char digest[65] = "";
    if (S_ISREG(metadata.st_mode)) {
      NativeHandle file;
      struct stat before;
      if (!regular_file_handle(parent, leaf, &file, &before)) {
        native_close(parent);
        return 0;
      }
      uint8_t *bytes;
      size_t length;
      if (!read_fd(file, &bytes, &length)) {
        native_close(file);
        native_close(parent);
        return 0;
      }
      digest_bytes(bytes, length, digest);
      free(bytes);
      native_close(file);
    }
    native_close(parent);
    respond_stat(kind, 1, (uint64_t)metadata.st_size, digest);
    return 1;
  }
  if (strcmp(request->op, "listDirectory") == 0) {
    NativeHandle directory = root;
    if (request->target[0] != '\0') {
      NativeHandle parent;
      char leaf[SAFE_MAX_COMPONENT + 1U];
      if (!open_parent(root, request->target, 0, &parent, leaf)) return 0;
      directory = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      native_close(parent);
      if (directory < 0) return 0;
    }
    const int listed = list_directory(directory);
    if (directory != root) native_close(directory);
    native_close(root);
    return listed;
  }
  if (strcmp(request->op, "readFile") == 0 || strcmp(request->op, "atomicWrite") == 0 || strcmp(request->op, "removeSessionTree") == 0) {
    NativeHandle parent;
    char leaf[SAFE_MAX_COMPONENT + 1U];
    if (!safe_target(request->target, 1) || !open_parent(root, request->target, 0, &parent, leaf)) return 0;
    if (strcmp(request->op, "readFile") == 0) {
      NativeHandle file;
      struct stat before;
      if (!regular_file_handle(parent, leaf, &file, &before)) {
        native_close(parent);
        return 0;
      }
      uint8_t *bytes;
      size_t length;
      if (!read_fd(file, &bytes, &length)) {
        native_close(file);
        native_close(parent);
        return 0;
      }
      char digest[65];
      digest_bytes(bytes, length, digest);
      respond_read(bytes, length, digest);
      free(bytes);
      native_close(file);
      native_close(parent);
      return 1;
    }
    if (strcmp(request->op, "removeSessionTree") == 0) {
      const NativeHandle directory = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat before;
      if (directory < 0 || fstat(directory, &before) < 0 || !remove_contents(directory)) {
        native_close(directory);
        native_close(parent);
        return 0;
      }
      struct stat after;
      const int same_directory =
          fstatat(parent, leaf, &after, AT_SYMLINK_NOFOLLOW) == 0 &&
          after.st_dev == before.st_dev && after.st_ino == before.st_ino && S_ISDIR(after.st_mode);
      if (!same_directory || unlinkat(parent, leaf, AT_REMOVEDIR) < 0) {
        native_close(directory);
        native_close(parent);
        errno = EAGAIN;
        return 0;
      }
      native_close(directory);
      native_close(parent);
      respond_mutation(request->op, 1, NULL, NULL);
      return 1;
    }
    if (!request->has_data) {
      native_close(parent);
      return 0;
    }
    uint8_t *bytes;
    size_t length;
    if (!base64_decode(request->data, &bytes, &length)) {
      native_close(parent);
      return 0;
    }
    char digest[65];
    digest_bytes(bytes, length, digest);
    if (request->has_expected_digest && (!is_hex_digest(request->expected_digest) || strcmp(digest, request->expected_digest) != 0)) {
      free(bytes);
      native_close(parent);
      respond_error(request->op, "conflict", "The atomic write digest did not match the request.");
      return 1;
    }
    if (!cleanup_staging_files(parent)) {
      free(bytes);
      native_close(parent);
      return 0;
    }
    char stage[SAFE_MAX_COMPONENT + 1U];
    NativeHandle staged = -1;
    for (unsigned int attempt = 0U; attempt < 64U; attempt += 1U) {
      (void)snprintf(stage, sizeof(stage), "holycodex-stage-%lu-%u", (unsigned long)getpid(), attempt);
      staged = openat(parent, stage, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (staged >= 0) break;
      if (errno != EEXIST) break;
    }
    if (staged < 0) {
      free(bytes);
      native_close(parent);
      return 0;
    }
    size_t written = 0U;
    while (written < length) {
      const ssize_t amount = write(staged, bytes + written, length - written);
      if (amount <= 0) break;
      written += (size_t)amount;
    }
    int stored = 0;
    if (written == length && fsync(staged) == 0 && close(staged) == 0) {
      staged = -1;
      if (renameat(parent, stage, parent, leaf) == 0 && fsync(parent) == 0) stored = 1;
    }
    if (!stored) {
      if (staged >= 0) native_close(staged);
      (void)unlinkat(parent, stage, 0);
      free(bytes);
      native_close(parent);
      return 0;
    }
    free(bytes);
    native_close(parent);
    respond_mutation(request->op, 1, digest, NULL);
    return 1;
  }
  native_close(root);
  return 0;
}

#else

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

typedef HANDLE NativeHandle;
typedef LONG NtStatus;
typedef struct {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
} LocalUnicodeString;
typedef struct {
  ULONG Length;
  HANDLE RootDirectory;
  LocalUnicodeString *ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
} LocalObjectAttributes;
typedef struct {
  union {
    NtStatus Status;
    PVOID Pointer;
  } DUMMYUNIONNAME;
  ULONG_PTR Information;
} LocalIoStatusBlock;
typedef NtStatus (NTAPI *NtCreateFileFn)(PHANDLE, ACCESS_MASK, LocalObjectAttributes *, LocalIoStatusBlock *, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

#define LOCAL_OBJ_CASE_INSENSITIVE 0x00000040UL
#define LOCAL_FILE_OPEN 1UL
#define LOCAL_FILE_CREATE 2UL
#define LOCAL_FILE_CREATE_NEW LOCAL_FILE_CREATE /* CREATE_NEW staging disposition */
#define LOCAL_FILE_OPEN_IF 3UL
#define LOCAL_FILE_NON_DIRECTORY_FILE 0x00000040UL
#define LOCAL_FILE_DIRECTORY_FILE 0x00000001UL
#define LOCAL_FILE_SYNCHRONOUS_IO_NONALERT 0x00000020UL
#define LOCAL_FILE_OPEN_REPARSE_POINT 0x00200000UL
#define LOCAL_FILE_ATTRIBUTE_DIRECTORY 0x00000010UL
#define LOCAL_FILE_ATTRIBUTE_REPARSE_POINT 0x00000400UL
#define LOCAL_FILE_DISPOSITION_INFO_EX 21
#define LOCAL_FILE_RENAME_INFO 3
#define LOCAL_FILE_RENAME_INFO_EX 22
#define LOCAL_FILE_DISPOSITION_FLAG_DELETE 0x00000001UL
#define LOCAL_FILE_DISPOSITION_FLAG_POSIX_SEMANTICS 0x00000002UL
#define LOCAL_FILE_RENAME_FLAG_REPLACE_IF_EXISTS 0x00000001UL
#define LOCAL_FILE_RENAME_FLAG_POSIX_SEMANTICS 0x00000002UL

typedef struct {
  DWORD Flags;
} LocalFileDispositionInfoEx;
typedef struct {
  DWORD Flags;
  HANDLE RootDirectory;
  DWORD FileNameLength;
  WCHAR FileName[1];
} LocalFileRenameInfoEx;
typedef struct {
  DWORD FileAttributes;
  DWORD ReparseTag;
} LocalFileAttributeTagInfo;

static NtCreateFileFn nt_create_file(void) {
  static NtCreateFileFn function;
  static int loaded;
  if (!loaded) {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    function = module == NULL ? NULL : (NtCreateFileFn)(void *)GetProcAddress(module, "NtCreateFile");
    loaded = 1;
  }
  return function;
}

static void native_close(NativeHandle handle) {
  if (handle != NULL && handle != INVALID_HANDLE_VALUE) (void)CloseHandle(handle);
}

static int utf8_to_wide(const char *input, WCHAR *output, int capacity) {
  const int result = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, output, capacity);
  return result > 0;
}

static int wide_to_utf8(const WCHAR *input, DWORD length, char *output, size_t capacity) {
  const int result = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input, (int)length, output, (int)capacity - 1, NULL, NULL);
  if (result <= 0) return 0;
  output[result] = '\0';
  return 1;
}

static int handle_is_reparse(NativeHandle handle) {
  LocalFileAttributeTagInfo info;
  memset(&info, 0, sizeof(info));
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return 1;
  return (info.FileAttributes & LOCAL_FILE_ATTRIBUTE_REPARSE_POINT) != 0U;
}

static int handle_is_directory(NativeHandle handle) {
  FILE_BASIC_INFO info;
  return GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info)) != 0 &&
         (info.FileAttributes & LOCAL_FILE_ATTRIBUTE_DIRECTORY) != 0U;
}

static int duplicate_handle(NativeHandle source, NativeHandle *result) {
  return DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), result, 0U, FALSE,
                         DUPLICATE_SAME_ACCESS) != 0;
}

static int root_identity_for_handle(NativeHandle root, char output[193]) {
  BY_HANDLE_FILE_INFORMATION metadata;
  if (!GetFileInformationByHandle(root, &metadata)) return 0;
  const uint64_t file_index = ((uint64_t)metadata.nFileIndexHigh << 32U) | metadata.nFileIndexLow;
  const int written = snprintf(output, 193U, "w:%08" PRIx32 ":%" PRIx64,
                               (uint32_t)metadata.dwVolumeSerialNumber, file_index);
  return written > 0 && (size_t)written < 193U;
}

static int root_identity_matches(NativeHandle root, const char *expected) {
  char actual[193];
  if (expected == NULL || expected[0] != 'w' || strlen(expected) < 5U || strlen(expected) >= 193U) return 0;
  return root_identity_for_handle(root, actual) && strcmp(actual, expected) == 0;
}

static int handle_below_root(NativeHandle root, NativeHandle child) {
  WCHAR root_path[32768];
  WCHAR child_path[32768];
  const DWORD root_length_result = GetFinalPathNameByHandleW(root, root_path, 32768U, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  const DWORD child_length_result = GetFinalPathNameByHandleW(child, child_path, 32768U, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (root_length_result == 0U || child_length_result == 0U || root_length_result >= 32768U || child_length_result >= 32768U) return 0;
  size_t root_length = wcslen(root_path);
  const size_t child_length = wcslen(child_path);
  while (root_length > 0U && (root_path[root_length - 1U] == L'\\' || root_path[root_length - 1U] == L'/')) root_length -= 1U;
  if (child_length < root_length) return 0;
  for (size_t index = 0U; index < root_length; index += 1U) {
    WCHAR left = root_path[index];
    WCHAR right = child_path[index];
    if (left >= L'A' && left <= L'Z') left = (WCHAR)(left + (L'a' - L'A'));
    if (right >= L'A' && right <= L'Z') right = (WCHAR)(right + (L'a' - L'A'));
    if (left != right) return 0;
  }
  return child_length == root_length || child_path[root_length] == L'\\' || child_path[root_length] == L'/';
}

static int nt_open_relative(NativeHandle parent, const WCHAR *name, int directory, ULONG disposition, NativeHandle *result) {
  NtCreateFileFn create_file = nt_create_file();
  if (create_file == NULL) return 0;
  LocalUnicodeString unicode;
  unicode.Length = (USHORT)(wcslen(name) * sizeof(WCHAR));
  unicode.MaximumLength = (USHORT)(unicode.Length + sizeof(WCHAR));
  unicode.Buffer = (PWSTR)name;
  LocalObjectAttributes attributes;
  memset(&attributes, 0, sizeof(attributes));
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &unicode;
  attributes.Attributes = LOCAL_OBJ_CASE_INSENSITIVE;
  LocalIoStatusBlock status;
  memset(&status, 0, sizeof(status));
  const ACCESS_MASK access = directory ? (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | DELETE | SYNCHRONIZE) : (GENERIC_READ | GENERIC_WRITE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | DELETE | SYNCHRONIZE);
  const ULONG share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  const ULONG options = (directory ? LOCAL_FILE_DIRECTORY_FILE : LOCAL_FILE_NON_DIRECTORY_FILE) | LOCAL_FILE_SYNCHRONOUS_IO_NONALERT | LOCAL_FILE_OPEN_REPARSE_POINT;
  const NtStatus result_status = create_file(result, access, &attributes, &status, NULL, FILE_ATTRIBUTE_NORMAL, share, disposition, options, NULL, 0U);
  if (result_status < 0) return 0;
  if (handle_is_reparse(*result) || (directory && !handle_is_directory(*result))) {
    native_close(*result);
    SetLastError(ERROR_CANT_ACCESS_FILE);
    return 0;
  }
  return 1;
}

static int safe_windows_root(const char *root, WCHAR *wide_root) {
  if (!utf8_to_wide(root, wide_root, 32768) || wcslen(wide_root) < 4U) return 0;
  if (!((wide_root[0] >= L'A' && wide_root[0] <= L'Z') || (wide_root[0] >= L'a' && wide_root[0] <= L'z')) || wide_root[1] != L':' || wide_root[2] != L'\\') return 0;
  if (wide_root[3] == L'\0' || wide_root[3] == L'\\') return 0;
  const WCHAR *start = wide_root + 3;
  for (const WCHAR *cursor = start;; cursor += 1) {
    if (*cursor == L'\\' || *cursor == L'\0') {
      const size_t length = (size_t)(cursor - start);
      char component[SAFE_MAX_COMPONENT * 4U + 1U];
      if (length == 0U || length > SAFE_MAX_COMPONENT ||
          !wide_to_utf8(start, (DWORD)length, component, sizeof(component)) ||
          !safe_root_component(component, strlen(component))) return 0;
      if (*cursor == L'\0') break;
      start = cursor + 1;
    }
  }
  return 1;
}

static int open_root(const char *root, int create, NativeHandle *result) {
  WCHAR wide_root[32768];
  if (!safe_windows_root(root, wide_root)) return 0;
  WCHAR volume[4] = {wide_root[0], L':', L'\\', L'\0'};
  NativeHandle current = CreateFileW(volume, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (current == INVALID_HANDLE_VALUE || handle_is_reparse(current) || !handle_is_directory(current)) {
    native_close(current);
    return 0;
  }
  const WCHAR *start = wide_root + 3;
  for (const WCHAR *cursor = start;; cursor += 1) {
    if (*cursor == L'\\' || *cursor == L'\0') {
      WCHAR component[SAFE_MAX_COMPONENT + 1U];
      const size_t length = (size_t)(cursor - start);
      if (length == 0U || length > SAFE_MAX_COMPONENT) {
        native_close(current);
        return 0;
      }
      wmemcpy(component, start, length);
      component[length] = L'\0';
      NativeHandle next;
      if (!nt_open_relative(current, component, 1, create ? LOCAL_FILE_OPEN_IF : LOCAL_FILE_OPEN, &next)) {
        native_close(current);
        return 0;
      }
      native_close(current);
      current = next;
      if (*cursor == L'\0') break;
      start = cursor + 1;
    }
  }
  *result = current;
  return 1;
}

static int open_parent(NativeHandle root, const char *target, int create, NativeHandle *parent, WCHAR leaf[SAFE_MAX_COMPONENT + 1U]) {
  if (!safe_target(target, 1)) return 0;
  NativeHandle current;
  if (!duplicate_handle(root, &current)) return 0;
  const char *start = target;
  for (const char *cursor = target;; cursor += 1) {
    if (*cursor == '/' || *cursor == '\0') {
      const size_t length = (size_t)(cursor - start);
      char component_utf8[SAFE_MAX_COMPONENT + 1U];
      WCHAR component[SAFE_MAX_COMPONENT + 1U];
      memcpy(component_utf8, start, length);
      component_utf8[length] = '\0';
      if (!utf8_to_wide(component_utf8, component, (int)(SAFE_MAX_COMPONENT + 1U))) {
        native_close(current);
        return 0;
      }
      if (*cursor == '\0') {
        wmemcpy(leaf, component, wcslen(component) + 1U);
        *parent = current;
        return 1;
      }
      NativeHandle next;
      if (!nt_open_relative(current, component, 1, create ? LOCAL_FILE_OPEN_IF : LOCAL_FILE_OPEN, &next)) {
        native_close(current);
        return 0;
      }
      native_close(current);
      current = next;
      start = cursor + 1;
    }
  }
}

static int mark_deleted(NativeHandle handle) {
  LocalFileDispositionInfoEx extended;
  extended.Flags = LOCAL_FILE_DISPOSITION_FLAG_DELETE | LOCAL_FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  if (SetFileInformationByHandle(handle, (FILE_INFO_BY_HANDLE_CLASS)LOCAL_FILE_DISPOSITION_INFO_EX,
                                 &extended, sizeof(extended))) return 1;
  FILE_DISPOSITION_INFO fallback;
  fallback.DeleteFile = TRUE;
  return SetFileInformationByHandle(handle, FileDispositionInfo, &fallback, sizeof(fallback)) != 0;
}

static int remove_contents(NativeHandle directory) {
  uint8_t buffer[64U * 1024U];
  memset(buffer, 0, sizeof(buffer));
  if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryInfo, buffer, sizeof(buffer))) {
    return GetLastError() == ERROR_NO_MORE_FILES;
  }
  size_t offset = 0U;
  for (;;) {
    FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)(void *)(buffer + offset);
    const size_t name_length = entry->FileNameLength / sizeof(WCHAR);
    if (name_length > 0U && !(name_length == 1U && entry->FileName[0] == L'.') && !(name_length == 2U && entry->FileName[0] == L'.' && entry->FileName[1] == L'.')) {
      if (name_length > SAFE_MAX_COMPONENT) return 0;
      WCHAR name[SAFE_MAX_COMPONENT + 1U];
      wmemcpy(name, entry->FileName, name_length);
      name[name_length] = L'\0';
      NativeHandle child;
      if (!nt_open_relative(directory, name, (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U, LOCAL_FILE_OPEN, &child)) return 0;
      if (handle_is_reparse(child)) {
        native_close(child);
        return 0;
      }
      if ((entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U && !remove_contents(child)) {
        native_close(child);
        return 0;
      }
      if (!mark_deleted(child)) {
        native_close(child);
        return 0;
      }
      native_close(child);
    }
    if (entry->NextEntryOffset == 0U) break;
    offset += entry->NextEntryOffset;
    if (offset >= sizeof(buffer)) return 0;
  }
  return 1;
}

static int cleanup_staging_files(NativeHandle directory) {
  uint8_t buffer[64U * 1024U];
  memset(buffer, 0, sizeof(buffer));
  if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryInfo, buffer, sizeof(buffer)) &&
      GetLastError() != ERROR_NO_MORE_FILES) return 0;
  size_t offset = 0U;
  for (;;) {
    FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)(void *)(buffer + offset);
    const size_t name_length = entry->FileNameLength / sizeof(WCHAR);
    if (name_length >= 16U && name_length <= SAFE_MAX_COMPONENT &&
        wcsncmp(entry->FileName, L"holycodex-stage-", 16U) == 0) {
      WCHAR name[SAFE_MAX_COMPONENT + 1U];
      wmemcpy(name, entry->FileName, name_length);
      name[name_length] = L'\0';
      NativeHandle staged = NULL;
      if (!nt_open_relative(directory, name, (entry->FileAttributes & LOCAL_FILE_ATTRIBUTE_DIRECTORY) != 0U,
                            LOCAL_FILE_OPEN, &staged) || handle_is_reparse(staged) || !mark_deleted(staged)) {
        native_close(staged);
        return 0;
      }
      native_close(staged);
    }
    if (entry->NextEntryOffset == 0U) break;
    offset += entry->NextEntryOffset;
    if (offset >= sizeof(buffer)) return 0;
  }
  return 1;
}

static int list_directory(NativeHandle directory) {
  uint8_t buffer[64U * 1024U];
  char response[SAFE_MAX_LINE];
  size_t used = (size_t)snprintf(response, sizeof(response), "{\"version\":%d,\"ok\":true,\"op\":\"listDirectory\",\"entries\":[", SAFE_PROTOCOL_VERSION);
  size_t count = 0U;
  memset(buffer, 0, sizeof(buffer));
  if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryInfo, buffer, sizeof(buffer)) &&
      GetLastError() != ERROR_NO_MORE_FILES) return 0;
  size_t offset = 0U;
  for (;;) {
    FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)(void *)(buffer + offset);
    const size_t name_length = entry->FileNameLength / sizeof(WCHAR);
    if (name_length > 0U && !(name_length == 1U && entry->FileName[0] == L'.') && !(name_length == 2U && entry->FileName[0] == L'.' && entry->FileName[1] == L'.')) {
      if (count >= SAFE_MAX_ENTRIES || name_length > SAFE_MAX_COMPONENT) return 0;
      char name[SAFE_MAX_COMPONENT * 4U + 1U];
      if (!wide_to_utf8(entry->FileName, (DWORD)name_length, name, sizeof(name))) return 0;
      const char *kind = (entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U ? "symlink" : (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ? "directory" : "file";
      const int written = snprintf(response + used, sizeof(response) - used, "%s{\"name\":\"%s\",\"kind\":\"%s\"}", count == 0U ? "" : ",", name, kind);
      if (written < 0 || (size_t)written >= sizeof(response) - used) return 0;
      used += (size_t)written;
      count += 1U;
    }
    if (entry->NextEntryOffset == 0U) break;
    offset += entry->NextEntryOffset;
    if (offset >= sizeof(buffer)) return 0;
  }
  if (used + 3U >= sizeof(response)) return 0;
  (void)snprintf(response + used, sizeof(response) - used, "]}\n");
  (void)fputs(response, stdout);
  return 1;
}

static int read_handle(NativeHandle file, uint8_t **bytes, size_t *length) {
  LARGE_INTEGER size;
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || (uint64_t)size.QuadPart > SAFE_MAX_FILE) return 0;
  const size_t capacity = (size_t)size.QuadPart;
  uint8_t *buffer = (uint8_t *)malloc(capacity == 0U ? 1U : capacity);
  if (buffer == NULL) return 0;
  size_t offset = 0U;
  while (offset < capacity) {
    DWORD amount = 0U;
    const DWORD requested = (DWORD)((capacity - offset) > 64U * 1024U ? 64U * 1024U : capacity - offset);
    if (!ReadFile(file, buffer + offset, requested, &amount, NULL) || amount == 0U) {
      free(buffer);
      return 0;
    }
    offset += amount;
  }
  *bytes = buffer;
  *length = capacity;
  return 1;
}

static int handle_windows(const Request *request) {
  if (strcmp(request->op, "ensureRoot") == 0) {
    NativeHandle root;
    if (!open_root(request->root, 1, &root)) return 0;
    char identity[193];
    if (!root_identity_for_handle(root, identity)) {
      native_close(root);
      return 0;
    }
    native_close(root);
    respond_mutation(request->op, 1, NULL, identity);
    return 1;
  }
  NativeHandle root;
  if (!request->has_root || !open_root(request->root, 0, &root)) return 0;
  if (!request->has_root_identity || !root_identity_matches(root, request->root_identity)) {
    native_close(root);
    respond_error(request->op, "root_identity", "The owned root identity changed or was not supplied.");
    return 1;
  }
  if (strcmp(request->op, "createSessionDir") == 0) {
    NativeHandle parent;
    WCHAR leaf[SAFE_MAX_COMPONENT + 1U];
    if (!request->has_target || !open_parent(root, request->target, 1, &parent, leaf)) return 0;
    NativeHandle directory;
    if (!nt_open_relative(parent, leaf, 1, LOCAL_FILE_OPEN_IF, &directory)) {
      native_close(parent);
      return 0;
    }
    const int safe = !handle_is_reparse(directory) && handle_below_root(root, directory);
    native_close(directory);
    native_close(parent);
    native_close(root);
    if (!safe) return 0;
    respond_mutation(request->op, 1, NULL, NULL);
    return 1;
  }
  if (!request->has_target || !safe_target(request->target, 0)) return 0;
  if (strcmp(request->op, "statDigest") == 0 && request->target[0] == '\0') {
    native_close(root);
    respond_stat("directory", 1, 0U, "");
    return 1;
  }
  NativeHandle parent = NULL;
  WCHAR leaf[SAFE_MAX_COMPONENT + 1U];
  if (!(strcmp(request->op, "listDirectory") == 0 && request->target[0] == '\0') &&
      !open_parent(root, request->target, 0, &parent, leaf)) return 0;
  NativeHandle target = NULL;
  if (strcmp(request->op, "statDigest") == 0) {
    if (!nt_open_relative(parent, leaf, 1, LOCAL_FILE_OPEN, &target) &&
        !nt_open_relative(parent, leaf, 0, LOCAL_FILE_OPEN, &target)) {
      native_close(parent);
      native_close(root);
      return 0;
    }
    if (!handle_below_root(root, target)) {
      native_close(target);
      native_close(parent);
      native_close(root);
      return 0;
    }
    if (handle_is_reparse(target)) {
      native_close(target);
      native_close(parent);
      native_close(root);
      respond_stat("symlink", 1, 0U, "");
      return 1;
    }
    LARGE_INTEGER size;
    char digest[65] = "";
    const int directory = handle_is_directory(target);
    if (!directory) {
      uint8_t *bytes;
      size_t length;
      if (!read_handle(target, &bytes, &length)) {
        native_close(target);
        native_close(parent);
        native_close(root);
        return 0;
      }
      digest_bytes(bytes, length, digest);
      size.QuadPart = (LONGLONG)length;
      free(bytes);
    } else {
      size.QuadPart = 0;
    }
    native_close(target);
    native_close(parent);
    native_close(root);
    respond_stat(directory ? "directory" : "file", 1, (uint64_t)size.QuadPart, digest);
    return 1;
  }
  if (strcmp(request->op, "listDirectory") == 0) {
    NativeHandle directory = root;
    int has_parent = 0;
    if (request->target[0] != '\0') {
      if (!nt_open_relative(parent, leaf, 1, LOCAL_FILE_OPEN, &directory) || !handle_below_root(root, directory)) {
        native_close(parent);
        native_close(root);
        return 0;
      }
      has_parent = 1;
    }
    const int listed = list_directory(directory);
    if (directory != root) native_close(directory);
    if (has_parent) native_close(parent);
    native_close(root);
    return listed;
  }
  if (strcmp(request->op, "readFile") == 0) {
    if (!nt_open_relative(parent, leaf, 0, LOCAL_FILE_OPEN, &target) || handle_is_reparse(target) || handle_is_directory(target) || !handle_below_root(root, target)) {
      native_close(target);
      native_close(parent);
      native_close(root);
      return 0;
    }
    uint8_t *bytes;
    size_t length;
    if (!read_handle(target, &bytes, &length)) {
      native_close(target);
      native_close(parent);
      native_close(root);
      return 0;
    }
    char digest[65];
    digest_bytes(bytes, length, digest);
    respond_read(bytes, length, digest);
    free(bytes);
    native_close(target);
    native_close(parent);
    native_close(root);
    return 1;
  }
  if (strcmp(request->op, "removeSessionTree") == 0) {
    if (!nt_open_relative(parent, leaf, 1, LOCAL_FILE_OPEN, &target) || handle_is_reparse(target) || !handle_below_root(root, target) || !remove_contents(target) || !mark_deleted(target)) {
      native_close(target);
      native_close(parent);
      native_close(root);
      return 0;
    }
    native_close(target);
    native_close(parent);
    native_close(root);
    respond_mutation(request->op, 1, NULL, NULL);
    return 1;
  }
  if (strcmp(request->op, "atomicWrite") == 0) {
    if (!request->has_data) return 0;
    uint8_t *bytes;
    size_t length;
    if (!base64_decode(request->data, &bytes, &length)) return 0;
    char digest[65];
    digest_bytes(bytes, length, digest);
    if (request->has_expected_digest && (!is_hex_digest(request->expected_digest) || strcmp(digest, request->expected_digest) != 0)) {
      free(bytes);
      native_close(parent);
      native_close(root);
      respond_error(request->op, "conflict", "The atomic write digest did not match the request.");
      return 1;
    }
    if (!cleanup_staging_files(parent)) {
      free(bytes);
      native_close(parent);
      native_close(root);
      respond_error(request->op, "io_error", "Atomic write staging cleanup failed.");
      return 1;
    }
    WCHAR stage[SAFE_MAX_COMPONENT + 1U];
    NativeHandle staged = NULL;
    for (unsigned int attempt = 0U; attempt < 64U; attempt += 1U) {
      (void)swprintf(stage, SAFE_MAX_COMPONENT + 1U, L"holycodex-stage-%lu-%u", GetCurrentProcessId(), attempt);
      if (nt_open_relative(parent, stage, 0, LOCAL_FILE_CREATE_NEW, &staged)) break;
    }
    if (staged == NULL) {
      free(bytes);
      native_close(parent);
      native_close(root);
      respond_error(request->op, "io_error", "Atomic write staging file creation failed.");
      return 1;
    }
    size_t written = 0U;
    while (written < length) {
      DWORD amount = 0U;
      const DWORD requested = (DWORD)((length - written) > 64U * 1024U ? 64U * 1024U : length - written);
      if (!WriteFile(staged, bytes + written, requested, &amount, NULL) || amount == 0U) break;
      written += amount;
    }
    const char *failure_message = NULL;
    if (written != length) failure_message = "Atomic write staging output failed.";
    else if (!FlushFileBuffers(staged)) failure_message = "Atomic write staging flush failed.";
    if (failure_message == NULL) {
      const size_t leaf_length = wcslen(leaf);
      const size_t allocation = sizeof(LocalFileRenameInfoEx) + leaf_length * sizeof(WCHAR);
      LocalFileRenameInfoEx *rename_info = (LocalFileRenameInfoEx *)calloc(1U, allocation);
      if (rename_info == NULL) failure_message = "Atomic write rename allocation failed.";
      else {
        rename_info->Flags = LOCAL_FILE_RENAME_FLAG_REPLACE_IF_EXISTS | LOCAL_FILE_RENAME_FLAG_POSIX_SEMANTICS;
        rename_info->RootDirectory = parent;
        rename_info->FileNameLength = (DWORD)(leaf_length * sizeof(WCHAR));
        memcpy(rename_info->FileName, leaf, leaf_length * sizeof(WCHAR));
        int renamed = SetFileInformationByHandle(staged, (FILE_INFO_BY_HANDLE_CLASS)LOCAL_FILE_RENAME_INFO_EX, rename_info, (DWORD)allocation) != 0;
        if (!renamed) {
          rename_info->Flags = LOCAL_FILE_RENAME_FLAG_REPLACE_IF_EXISTS;
          renamed = SetFileInformationByHandle(staged, (FILE_INFO_BY_HANDLE_CLASS)LOCAL_FILE_RENAME_INFO, rename_info, (DWORD)allocation) != 0;
        }
        if (!renamed) {
          failure_message = "Atomic write rename failed.";
        }
        free(rename_info);
      }
    }
    if (failure_message == NULL && !FlushFileBuffers(staged)) {
      failure_message = "Atomic write post-rename flush failed.";
    }
    if (failure_message != NULL) (void)mark_deleted(staged);
    native_close(staged);
    free(bytes);
    native_close(parent);
    native_close(root);
    if (failure_message != NULL) {
      respond_error(request->op, "io_error", failure_message);
      return 1;
    }
    respond_mutation(request->op, 1, digest, NULL);
    return 1;
  }
  native_close(parent);
  native_close(root);
  return 0;
}

#endif

static void respond_native_failure(const char *op) {
#ifdef _WIN32
  const DWORD error = GetLastError();
  const char *code = error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? "not_found" : error == ERROR_REPARSE_TAG_INVALID || error == ERROR_CANT_ACCESS_FILE ? "link_reparse" : error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS ? "already_exists" : "io_error";
#else
  const char *code = native_error_name(errno);
#endif
  respond_error(op, code, "The safe filesystem native operation failed.");
}

int main(void) {
  static char line[SAFE_MAX_LINE + 2U];
  if (fgets(line, (int)sizeof(line), stdin) == NULL) {
    respond_error("version", "protocol_error", "The helper received no request.");
    return 2;
  }
  const size_t length = strlen(line);
  if (length == 0U || length > SAFE_MAX_LINE || (line[length - 1U] != '\n' && !feof(stdin))) {
    respond_error("version", "protocol_error", "The helper request exceeded its length bound.");
    return 2;
  }
  if (length > 0U && line[length - 1U] == '\n') line[length - 1U] = '\0';
  Request *request = (Request *)calloc(1U, sizeof(Request));
  if (request == NULL || !protocol_version_is_supported(line) || !parse_request(line, strlen(line), request)) {
    respond_error("version", "protocol_error", "The helper request is not a flat JSON object.");
    free(request);
    return 2;
  }
  if (!operation_is_supported(request->op)) {
    respond_error(request->op, "invalid_input", "The helper operation is not supported by this version.");
    free(request);
    return 2;
  }
  if (strcmp(request->op, "version") == 0) {
    respond_version();
    free(request);
    return 0;
  }
  if (!request->has_root) {
    respond_error(request->op, "invalid_input", "The helper request is missing an owned root.");
    free(request);
    return 2;
  }
  if (strcmp(request->op, "ensureRoot") != 0 &&
      (!request->has_target ||
       !safe_target(request->target, strcmp(request->op, "statDigest") != 0 && strcmp(request->op, "listDirectory") != 0))) {
    respond_error(request->op, "invalid_path", "The helper target is not a strict relative component path.");
    free(request);
    return 2;
  }
#ifdef _WIN32
  const int handled = handle_windows(request);
#else
  const int handled = handle_posix(request);
#endif
  if (!handled) {
    respond_native_failure(request->op);
    free(request);
    return 1;
  }
  free(request);
  return 0;
}

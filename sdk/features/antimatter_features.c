#define _POSIX_C_SOURCE 200809L
#include "antimatter_features.h"
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

static int identifier(const char *text) {
    size_t length;
    if (!text || !(('A' <= text[0] && text[0] <= 'Z') || ('a' <= text[0] && text[0] <= 'z'))) return 0;
    for (length = 1; text[length] && length <= 80; ++length) {
        char c = text[length];
        if (!(('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || c == '_' || c == '.' || c == '-')) return 0;
    }
    return length <= 80;
}

static int request(const char *endpoint, const char *line, char *output, size_t capacity) {
    struct sockaddr_un address;
    struct stat metadata;
    struct timeval deadline = { 2, 0 };
    size_t sent = 0, used = 0, length;
    int socket_fd;
    if (!endpoint || !output || capacity < 2 || capacity > 1024 * 1024 || endpoint[0] != '/' || strlen(endpoint) >= sizeof(address.sun_path)) return -1;
    /* An endpoint copied from the UI must still be this user's private Unix socket. */
    if (lstat(endpoint, &metadata) || !S_ISSOCK(metadata.st_mode) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077)) return -1;
    socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (socket_fd < 0) return -1;
#ifdef SO_NOSIGPIPE
    { int one = 1; if (setsockopt(socket_fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one))) goto failed; }
#endif
    if (setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline)) || setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline))) goto failed;
    memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
    memcpy(address.sun_path, endpoint, strlen(endpoint) + 1);
    if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address))) goto failed;
    length = strlen(line);
    while (sent < length) {
        ssize_t count = send(socket_fd, line + sent, length - sent, MSG_NOSIGNAL);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) goto failed;
        sent += (size_t)count;
    }
    while (used < capacity - 1) {
        ssize_t count = recv(socket_fd, output + used, capacity - used - 1, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) goto failed;
        if (memchr(output + used, '\0', (size_t)count)) goto failed;
        used += (size_t)count;
        if (output[used - 1] == '\n') { output[used - 1] = '\0'; close(socket_fd); return (int)(used - 1); }
        if (memchr(output, '\n', used)) goto failed;
    }
failed:
    output[0] = '\0'; close(socket_fd); return -1;
}

static int64_t flag(const char *endpoint, const char *application, const char *key, const char *operation, int value, int has_value) {
    char line[256], response[512];
    int written;
    if (!identifier(application) || !identifier(key)) return -1;
    written = has_value ? snprintf(line, sizeof(line), "1\t%s\t%s\t%s\t%d\n", operation, application, key, value)
        : snprintf(line, sizeof(line), "1\t%s\t%s\t%s\n", operation, application, key);
    if (written < 0 || (size_t)written >= sizeof(line) || request(endpoint, line, response, sizeof(response)) < 0) return -1;
    if (!strcmp(response, "OK\t1")) return 1;
    if (!strcmp(response, "OK\t0")) return 0;
    return -1;
}
int64_t antimatter_feature_get(const char *endpoint, const char *application, const char *key) { return flag(endpoint, application, key, "GET", 0, 0); }
int64_t antimatter_feature_declare(const char *endpoint, const char *application, const char *key, int64_t enabled) {
    if (enabled != 0 && enabled != 1) return -1;
    return flag(endpoint, application, key, "DECLARE", (int)enabled, 1);
}
int64_t antimatter_feature_set(const char *endpoint, const char *application, const char *key, int64_t value) {
    if (value < -1 || value > 1) return -1;
    return flag(endpoint, application, key, "SET", (int)value, 1);
}
int64_t antimatter_features_list(const char *endpoint, const char *application, char *output, size_t capacity) {
    char line[128]; int count;
    if (!identifier(application) || !output || capacity < 5) return -1;
    snprintf(line, sizeof(line), "1\tLIST\t%s\n", application);
    count = request(endpoint, line, output, capacity);
    if (count < 3 || strncmp(output, "OK\t", 3)) { output[0] = '\0'; return -1; }
    memmove(output, output + 3, (size_t)count - 2); return count - 3;
}

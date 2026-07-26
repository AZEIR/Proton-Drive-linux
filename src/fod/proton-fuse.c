#define FUSE_USE_VERSION 31

#include <fuse3/fuse.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>

static char g_db_path[512] = {0};
static char g_cache_dir[512] = {0};
static int g_daemon_port = 8085;

static void get_cache_path(const char* node_uid, char* out_path, size_t out_size) {
    snprintf(out_path, out_size, "%s/%s", g_cache_dir, node_uid);
}

static int request_hydration(const char* node_uid) {
    char cmd[1024];
    snprintf(cmd, sizeof(cmd), "curl -s -f \"http://127.0.0.1:%d/api/fod/hydrate?nodeUid=%s\" >/dev/null 2>&1", g_daemon_port, node_uid);
    int res = system(cmd);
    return (res == 0) ? 0 : -EIO;
}

static int pf_getattr(const char *path, struct stat *stbuf, struct fuse_file_info *fi) {
    (void) fi;
    memset(stbuf, 0, sizeof(struct stat));

    if (strcmp(path, "/") == 0) {
        stbuf->st_mode = S_IFDIR | 0755;
        stbuf->st_nlink = 2;
        stbuf->st_uid = getuid();
        stbuf->st_gid = getgid();
        return 0;
    }

    sqlite3 *db;
    if (sqlite3_open_v2(g_db_path, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        return -EIO;
    }

    const char *rel_path = path + 1;
    sqlite3_stmt *stmt;
    const char *query = "SELECT is_dir, size, mtime FROM sync_mappings WHERE local_path = ?;";
    
    int is_dir = 0;
    int64_t size = 0;
    int64_t mtime = 0;
    int found = 0;

    if (sqlite3_prepare_v2(db, query, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, rel_path, -1, SQLITE_STATIC);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            is_dir = sqlite3_column_int(stmt, 0);
            size = sqlite3_column_int64(stmt, 1);
            mtime = sqlite3_column_int64(stmt, 2);
            found = 1;
        }
        sqlite3_finalize(stmt);
    }

    if (!found) {
        char prefix_query[512];
        snprintf(prefix_query, sizeof(prefix_query), "%s/%%", rel_path);
        const char *dir_check = "SELECT 1 FROM sync_mappings WHERE local_path LIKE ? LIMIT 1;";
        if (sqlite3_prepare_v2(db, dir_check, -1, &stmt, NULL) == SQLITE_OK) {
            sqlite3_bind_text(stmt, 1, prefix_query, -1, SQLITE_STATIC);
            if (sqlite3_step(stmt) == SQLITE_ROW) {
                is_dir = 1;
                found = 1;
            }
            sqlite3_finalize(stmt);
        }
    }

    sqlite3_close(db);

    if (!found) return -ENOENT;

    stbuf->st_uid = getuid();
    stbuf->st_gid = getgid();
    time_t sec = mtime > 0 ? (time_t)(mtime / 1000) : time(NULL);
    stbuf->st_mtime = sec;
    stbuf->st_atime = sec;
    stbuf->st_ctime = sec;

    if (is_dir) {
        stbuf->st_mode = S_IFDIR | 0755;
        stbuf->st_nlink = 2;
        stbuf->st_size = 4096;
    } else {
        stbuf->st_mode = S_IFREG | 0644;
        stbuf->st_nlink = 1;
        stbuf->st_size = size;
    }

    return 0;
}

static int pf_readdir(const char *path, void *buf, fuse_fill_dir_t filler, off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
    (void) offset; (void) fi; (void) flags;

    filler(buf, ".", NULL, 0, 0);
    filler(buf, "..", NULL, 0, 0);

    sqlite3 *db;
    if (sqlite3_open_v2(g_db_path, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        return -EIO;
    }

    const char *norm = strcmp(path, "/") == 0 ? "" : path + 1;
    size_t norm_len = strlen(norm);

    static char added_entries[2048][256];
    int added_count = 0;

    sqlite3_stmt *stmt;
    const char *query = "SELECT local_path FROM sync_mappings;";
    if (sqlite3_prepare_v2(db, query, -1, &stmt, NULL) == SQLITE_OK) {
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            const char *lp = (const char*)sqlite3_column_text(stmt, 0);
            if (!lp) continue;

            char entry_name[256] = {0};
            if (norm_len == 0) {
                const char *slash = strchr(lp, '/');
                if (slash) {
                    size_t len = slash - lp;
                    if (len < sizeof(entry_name)) {
                        strncpy(entry_name, lp, len);
                    }
                } else {
                    strncpy(entry_name, lp, sizeof(entry_name) - 1);
                }
            } else {
                if (strncmp(lp, norm, norm_len) == 0 && lp[norm_len] == '/') {
                    const char *sub = lp + norm_len + 1;
                    const char *slash = strchr(sub, '/');
                    if (slash) {
                        size_t len = slash - sub;
                        if (len < sizeof(entry_name)) {
                            strncpy(entry_name, sub, len);
                        }
                    } else {
                        strncpy(entry_name, sub, sizeof(entry_name) - 1);
                    }
                }
            }

            if (entry_name[0] != '\0') {
                int exists = 0;
                for (int i = 0; i < added_count; i++) {
                    if (strcmp(added_entries[i], entry_name) == 0) {
                        exists = 1;
                        break;
                    }
                }
                if (!exists && added_count < 2048) {
                    strncpy(added_entries[added_count++], entry_name, 255);
                    filler(buf, entry_name, NULL, 0, 0);
                }
            }
        }
        sqlite3_finalize(stmt);
    }

    sqlite3_close(db);
    return 0;
}

static int pf_open(const char *path, struct fuse_file_info *fi) {
    (void) fi;
    sqlite3 *db;
    if (sqlite3_open_v2(g_db_path, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        return -EIO;
    }

    const char *rel_path = path + 1;
    sqlite3_stmt *stmt;
    const char *query = "SELECT node_uid FROM sync_mappings WHERE local_path = ?;";
    int found = 0;

    if (sqlite3_prepare_v2(db, query, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, rel_path, -1, SQLITE_STATIC);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            found = 1;
        }
        sqlite3_finalize(stmt);
    }
    sqlite3_close(db);

    return found ? 0 : -ENOENT;
}

static int pf_read(const char *path, char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    (void) fi;
    sqlite3 *db;
    if (sqlite3_open_v2(g_db_path, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        return -EIO;
    }

    const char *rel_path = path + 1;
    char node_uid[128] = {0};
    int found = 0;

    sqlite3_stmt *stmt;
    const char *query = "SELECT node_uid FROM sync_mappings WHERE local_path = ?;";
    if (sqlite3_prepare_v2(db, query, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, rel_path, -1, SQLITE_STATIC);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            const char* uid = (const char*)sqlite3_column_text(stmt, 0);
            if (uid) {
                strncpy(node_uid, uid, sizeof(node_uid) - 1);
                found = 1;
            }
        }
        sqlite3_finalize(stmt);
    }
    sqlite3_close(db);

    if (!found) return -ENOENT;

    char cache_path[512];
    get_cache_path(node_uid, cache_path, sizeof(cache_path));

    if (access(cache_path, R_OK) != 0) {
        if (request_hydration(node_uid) != 0) {
            return -EIO;
        }
    }

    int fd = open(cache_path, O_RDONLY);
    if (fd < 0) return -EIO;

    ssize_t res = pread(fd, buf, size, offset);
    close(fd);

    return (res < 0) ? -EIO : (int)res;
}

static const struct fuse_operations pf_oper = {
    .getattr = pf_getattr,
    .readdir = pf_readdir,
    .open    = pf_open,
    .read    = pf_read,
};

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: proton-fuse <mount_point> [db_path] [cache_dir]\n");
        return 1;
    }

    const char *home = getenv("HOME") ? getenv("HOME") : "/tmp";
    snprintf(g_db_path, sizeof(g_db_path), "%s/.config/proton-drive-sync/sync_state.db", home);
    snprintf(g_cache_dir, sizeof(g_cache_dir), "%s/.cache/proton-drive-sync/fod-cache", home);

    if (argc >= 3) strncpy(g_db_path, argv[2], sizeof(g_db_path) - 1);
    if (argc >= 4) strncpy(g_cache_dir, argv[3], sizeof(g_cache_dir) - 1);

    mkdir(g_cache_dir, 0755);

    char *fuse_argv[3];
    fuse_argv[0] = argv[0];
    fuse_argv[1] = argv[1];
    fuse_argv[2] = "-f";

    return fuse_main(3, fuse_argv, &pf_oper, NULL);
}

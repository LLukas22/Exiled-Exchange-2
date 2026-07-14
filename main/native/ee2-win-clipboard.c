#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <windows.h>

static WCHAR *read_clipboard(void) {
    WCHAR *copy = NULL;
    if (!OpenClipboard(NULL)) return NULL;
    HANDLE data = GetClipboardData(CF_UNICODETEXT);
    if (data) {
        const WCHAR *text = GlobalLock(data);
        if (text) {
            size_t bytes = (wcslen(text) + 1) * sizeof(WCHAR);
            copy = HeapAlloc(GetProcessHeap(), 0, bytes);
            if (copy) memcpy(copy, text, bytes);
            GlobalUnlock(data);
        }
    }
    CloseClipboard();
    return copy;
}

static int set_clipboard(const WCHAR *text) {
    if (!OpenClipboard(NULL)) return 0;
    if (!EmptyClipboard()) {
        CloseClipboard();
        return 0;
    }
    if (text) {
        size_t bytes = (wcslen(text) + 1) * sizeof(WCHAR);
        HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE, bytes);
        WCHAR *dest = data ? GlobalLock(data) : NULL;
        if (!dest) {
            if (data) GlobalFree(data);
            CloseClipboard();
            return 0;
        }
        memcpy(dest, text, bytes);
        GlobalUnlock(data);
        if (!SetClipboardData(CF_UNICODETEXT, data)) {
            GlobalFree(data);
            CloseClipboard();
            return 0;
        }
    }
    CloseClipboard();
    return 1;
}

static void write_utf8(const WCHAR *text) {
    int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
    char *utf8 = HeapAlloc(GetProcessHeap(), 0, size);
    if (!utf8) return;
    WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, size, NULL, NULL);
    fwrite(utf8, 1, size - 1, stdout);
    HeapFree(GetProcessHeap(), 0, utf8);
}

int main(int argc, char **argv) {
    int restore = argc > 1 && strcmp(argv[1], "--restore") == 0;
    WCHAR *original = read_clipboard();
    if (!set_clipboard(NULL)) return 2;

    puts("EE2_READY");
    fflush(stdout);

    ULONGLONG deadline = GetTickCount64() + 3000;
    WCHAR *item = NULL;
    while (GetTickCount64() < deadline) {
        Sleep(40);
        item = read_clipboard();
        if (item && item[0]) break;
        if (item) HeapFree(GetProcessHeap(), 0, item);
        item = NULL;
    }

    if (!item) {
        if (restore) set_clipboard(original);
        if (original) HeapFree(GetProcessHeap(), 0, original);
        return 3;
    }

    write_utf8(item);
    if (restore) set_clipboard(original);
    HeapFree(GetProcessHeap(), 0, item);
    if (original) HeapFree(GetProcessHeap(), 0, original);
    return 0;
}

// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <SDL.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <windows.h>
#endif

class SessionChrome {
  public:
    enum Action { Pass, Consumed, Disconnect, AudioChanged };
    bool muted = false;
    bool panel = false;
    bool performance = false;
    int quality = 0;
    double measuredFps = 0, videoMbps = 0;
    uint32_t rtt = 0;
    bool hasRtt = false;
    int videoWidth = 0, videoHeight = 0;
    unsigned long long audioPackets = 0;
    uint64_t connectedAt = 0;
    std::string name = "SolunaRemote";

    int height() const {
#ifdef _WIN32
        return 54;
#else
        return 0;
#endif
    }

    void initialize(SDL_Window *window) {
#ifdef _WIN32
        SDL_SetWindowBordered(window, SDL_FALSE);
        if (SDL_SetWindowHitTest(window, hitTest, this) != 0)
            throw std::runtime_error(std::string("Cannot initialize session title bar: ") + SDL_GetError());
#else
        (void)window;
#endif
    }

    Action handle(const SDL_Event &event, SDL_Window *window) {
        if (!height())
            return Pass;
        int w, h;
        SDL_GetWindowSize(window, &w, &h);
        if (event.type == SDL_KEYDOWN && panel && event.key.keysym.sym == SDLK_ESCAPE) {
            panel = false;
            return Consumed;
        }
        int x = 0, y = 0;
        if (event.type == SDL_MOUSEMOTION) {
            x = event.motion.x;
            y = event.motion.y;
        } else if (event.type == SDL_MOUSEBUTTONDOWN || event.type == SDL_MOUSEBUTTONUP) {
            x = event.button.x;
            y = event.button.y;
        } else if (event.type == SDL_MOUSEWHEEL) {
            SDL_GetMouseState(&x, &y);
        } else {
            return panel && (event.type == SDL_KEYDOWN || event.type == SDL_KEYUP) ? Consumed : Pass;
        }
        const bool overPanel = panel && x >= w - 286 && y >= height() && y < height() + 240;
        if (event.type == SDL_MOUSEBUTTONDOWN && event.button.button == SDL_BUTTON_LEFT) {
            if (y < height()) {
                if (x >= w - 46)
                    return Disconnect;
                if (x >= w - 92) {
                    if (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN_DESKTOP)
                        toggleFullscreen(window);
                    else if (SDL_GetWindowFlags(window) & SDL_WINDOW_MAXIMIZED)
                        SDL_RestoreWindow(window);
                    else
                        SDL_MaximizeWindow(window);
                } else if (x >= w - 138)
                    SDL_MinimizeWindow(window);
                else if (x >= w - 280)
                    panel = !panel;
                return Consumed;
            }
            if (overPanel) {
                const int row = (y - height() - 12) / 50;
                if (y >= height() + 12 && row >= 0 && row < 4) {
                    if (row == 0)
                        toggleFullscreen(window);
                    if (row == 1) {
                        muted = !muted;
                        return AudioChanged;
                    }
                    if (row == 2)
                        performance = !performance;
                    if (row == 3)
                        return Disconnect;
                }
                return Consumed;
            }
            if (panel) {
                panel = false;
                return Consumed;
            }
        }
        return y < height() || overPanel ? Consumed : Pass;
    }

    void draw(SDL_Renderer *renderer, SDL_Window *window, bool connected) {
        if (!height())
            return;
        int w, h;
        SDL_GetWindowSize(window, &w, &h);
        fill(renderer, {0, 0, w, height()}, {226, 232, 241, 255});
        fill(renderer, {0, height() - 1, w, 1}, {199, 209, 224, 255});
        fill(renderer, {17, 18, 12, 12}, {57, 118, 250, 255});
        fill(renderer, {25, 26, 10, 10}, {35, 198, 185, 255});
        text(renderer, name, 48, 16, std::min(170, w / 4), {31, 44, 66, 255});
        if (w >= 780) {
            fill(renderer, {232, 7, 210, height() - 7}, {249, 251, 255, 255});
            text(renderer, "\xe8\xbf\x9c\xe7\xa8\x8b\xe6\xa1\x8c\xe9\x9d\xa2", 252, 17, 170,
                 {38, 53, 78, 255});
        }
        const int timeX = 476;
        const SDL_Color signal = connected
                                     ? (quality ? SDL_Color{218, 147, 32, 255} : SDL_Color{16, 173, 131, 255})
                                     : SDL_Color{136, 150, 170, 255};
        for (int i = 0; i < 3; ++i)
            fill(renderer, {timeX + i * 6, 32 - i * 5, 3, 5 + i * 5}, signal);
        const auto seconds = connectedAt ? (SDL_GetTicks64() - connectedAt) / 1000 : 0;
        char duration[32];
        std::snprintf(duration, sizeof(duration), "%02llu:%02llu:%02llu",
                      static_cast<unsigned long long>(seconds / 3600),
                      static_cast<unsigned long long>((seconds / 60) % 60),
                      static_cast<unsigned long long>(seconds % 60));
        if (timeX + 120 < w - 280)
            text(renderer, connected ? duration : "Connecting...", timeX + 26, 17, 110, {66, 89, 123, 255});
        fill(renderer, {w - 280, 0, 142, height() - 1},
             panel ? SDL_Color{208, 221, 244, 255} : SDL_Color{226, 232, 241, 255});
        text(renderer, "\xe6\x8e\xa7\xe5\x88\xb6\xe4\xb8\xad\xe5\xbf\x83", w - 262, 17, 120,
             {38, 53, 78, 255});
        SDL_SetRenderDrawColor(renderer, 54, 68, 91, 255);
        SDL_RenderDrawLine(renderer, w - 119, 27, w - 103, 27);
        SDL_Rect maximize{w - 75, 20, 13, 13};
        SDL_RenderDrawRect(renderer, &maximize);
        SDL_RenderDrawLine(renderer, w - 30, 21, w - 18, 33);
        SDL_RenderDrawLine(renderer, w - 30, 33, w - 18, 21);
        if (panel) {
            fill(renderer, {w - 286, height() + 5, 278, 232}, {246, 249, 254, 250});
            const char *actions[] = {
                "\xe5\x88\x87\xe6\x8d\xa2\xe5\x85\xa8\xe5\xb1\x8f",
                muted ? "\xe6\x81\xa2\xe5\xa4\x8d\xe5\xa3\xb0\xe9\x9f\xb3" : "\xe9\x9d\x99\xe9\x9f\xb3",
                performance ? "\xe9\x9a\x90\xe8\x97\x8f\xe6\x80\xa7\xe8\x83\xbd\xe4\xbf\xa1\xe6\x81\xaf"
                            : "\xe6\x98\xbe\xe7\xa4\xba\xe6\x80\xa7\xe8\x83\xbd\xe4\xbf\xa1\xe6\x81\xaf",
                "\xe6\x96\xad\xe5\xbc\x80\xe8\xbf\x9e\xe6\x8e\xa5"};
            for (int i = 0; i < 4; ++i)
                text(renderer, actions[i], w - 263, height() + 26 + i * 50, 230,
                     i == 3 ? SDL_Color{195, 65, 77, 255} : SDL_Color{38, 53, 78, 255});
        }
        if (performance) {
            const int top = std::max(height() + 10, h - 174);
            fill(renderer, {w - 242, top, 228, 158}, {15, 23, 38, 224});
            char line[96];
            std::snprintf(line, sizeof(line), "%d x %d   SDR", videoWidth, videoHeight);
            text(renderer, line, w - 225, top + 14, 202, {232, 240, 253, 255});
            std::snprintf(line, sizeof(line), "%.1f FPS  |  %.2f Mbps", measuredFps, videoMbps);
            text(renderer, line, w - 225, top + 44, 202, {232, 240, 253, 255});
            std::snprintf(line, sizeof(line), hasRtt ? "RTT %u ms  |  LAN" : "RTT --  |  LAN", rtt);
            text(renderer, line, w - 225, top + 74, 202, {232, 240, 253, 255});
            std::snprintf(line, sizeof(line), "Opus packets: %llu", audioPackets);
            text(renderer, line, w - 225, top + 104, 202, {232, 240, 253, 255});
        }
    }

    void release() {
#ifdef _WIN32
        for (const auto &entry : labels)
            SDL_DestroyTexture(entry.second.texture);
        labels.clear();
#endif
    }
    ~SessionChrome() {
        release();
    }

  private:
    static void toggleFullscreen(SDL_Window *window) {
        if (SDL_SetWindowFullscreen(window, SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN_DESKTOP
                                                ? 0
                                                : SDL_WINDOW_FULLSCREEN_DESKTOP) != 0)
            throw std::runtime_error(std::string("Cannot change session fullscreen mode: ") + SDL_GetError());
    }
    static void fill(SDL_Renderer *renderer, SDL_Rect rect, SDL_Color color) {
        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_BLEND);
        SDL_SetRenderDrawColor(renderer, color.r, color.g, color.b, color.a);
        SDL_RenderFillRect(renderer, &rect);
    }
#ifdef _WIN32
    struct Label {
        SDL_Texture *texture;
        int width, height;
    };
    std::map<std::string, Label> labels;
    static SDL_HitTestResult SDLCALL hitTest(SDL_Window *window, const SDL_Point *point, void *) {
        int w, h;
        SDL_GetWindowSize(window, &w, &h);
        if (!(SDL_GetWindowFlags(window) & (SDL_WINDOW_MAXIMIZED | SDL_WINDOW_FULLSCREEN_DESKTOP))) {
            const bool left = point->x < 6, right = point->x >= w - 6, top = point->y < 6,
                       bottom = point->y >= h - 6;
            if (top && left)
                return SDL_HITTEST_RESIZE_TOPLEFT;
            if (top && right)
                return SDL_HITTEST_RESIZE_TOPRIGHT;
            if (bottom && left)
                return SDL_HITTEST_RESIZE_BOTTOMLEFT;
            if (bottom && right)
                return SDL_HITTEST_RESIZE_BOTTOMRIGHT;
            if (left)
                return SDL_HITTEST_RESIZE_LEFT;
            if (right)
                return SDL_HITTEST_RESIZE_RIGHT;
            if (top)
                return SDL_HITTEST_RESIZE_TOP;
            if (bottom)
                return SDL_HITTEST_RESIZE_BOTTOM;
        }
        return point->y < 54 && point->x < w - 280 ? SDL_HITTEST_DRAGGABLE : SDL_HITTEST_NORMAL;
    }
#endif
    void text(SDL_Renderer *renderer, const std::string &value, int x, int y, int maxWidth, SDL_Color color) {
#ifdef _WIN32
        const std::string key = value + ":" + std::to_string(color.r) + ":" + std::to_string(color.g) + ":" +
                                std::to_string(color.b);
        auto found = labels.find(key);
        if (found == labels.end()) {
            if (labels.size() >= 128) {
                for (const auto &entry : labels)
                    SDL_DestroyTexture(entry.second.texture);
                labels.clear();
            }
            const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(),
                                                  static_cast<int>(value.size()), nullptr, 0);
            if (count <= 0)
                throw std::runtime_error("Invalid session label UTF-8");
            std::wstring wide(count, L'\0');
            MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()),
                                wide.data(), count);
            HDC dc = CreateCompatibleDC(nullptr);
            HFONT font =
                CreateFontW(-17, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH, L"Segoe UI");
            if (!dc || !font) {
                if (font)
                    DeleteObject(font);
                if (dc)
                    DeleteDC(dc);
                throw std::runtime_error("Cannot initialize session text rendering");
            }
            auto oldFont = SelectObject(dc, font);
            SIZE size{};
            GetTextExtentPoint32W(dc, wide.data(), count, &size);
            const int width = std::max(1L, size.cx + 2), height = 26;
            BITMAPINFO info{};
            info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = width;
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            void *pixels = nullptr;
            HBITMAP bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
            if (!bitmap) {
                SelectObject(dc, oldFont);
                DeleteObject(font);
                DeleteDC(dc);
                throw std::runtime_error("Cannot allocate session label bitmap");
            }
            auto oldBitmap = SelectObject(dc, bitmap);
            std::memset(pixels, 0, static_cast<size_t>(width) * height * 4);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, RGB(255, 255, 255));
            TextOutW(dc, 0, 0, wide.data(), count);
            GdiFlush();
            auto *bytes = static_cast<unsigned char *>(pixels);
            for (int i = 0; i < width * height; ++i) {
                const auto alpha = std::max({bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2]});
                bytes[i * 4] = color.b;
                bytes[i * 4 + 1] = color.g;
                bytes[i * 4 + 2] = color.r;
                bytes[i * 4 + 3] = alpha;
            }
            SDL_Surface *surface = SDL_CreateRGBSurfaceWithFormatFrom(pixels, width, height, 32, width * 4,
                                                                      SDL_PIXELFORMAT_BGRA32);
            SDL_Texture *texture = surface ? SDL_CreateTextureFromSurface(renderer, surface) : nullptr;
            SDL_FreeSurface(surface);
            SelectObject(dc, oldBitmap);
            DeleteObject(bitmap);
            SelectObject(dc, oldFont);
            DeleteObject(font);
            DeleteDC(dc);
            if (!texture)
                throw std::runtime_error(std::string("Cannot upload session label: ") + SDL_GetError());
            SDL_SetTextureBlendMode(texture, SDL_BLENDMODE_BLEND);
            found = labels.emplace(key, Label{texture, width, height}).first;
        }
        const auto &label = found->second;
        SDL_Rect source{0, 0, std::min(label.width, maxWidth), label.height};
        SDL_Rect destination{x, y, source.w, source.h};
        SDL_RenderCopy(renderer, label.texture, &source, &destination);
#else
        (void)renderer;
        (void)value;
        (void)x;
        (void)y;
        (void)maxWidth;
        (void)color;
#endif
    }
};

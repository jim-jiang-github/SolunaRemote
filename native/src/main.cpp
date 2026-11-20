// SPDX-License-Identifier: GPL-3.0-or-later
#include <Limelight.h>
#include <SDL.h>
#include <nlohmann/json.hpp>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/x509v3.h>
#include <opus/opus_multistream.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
}
#include "session-chrome.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#else
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

using Json = nlohmann::json;
static std::mutex outputMutex;
static void emit(const Json &event) {
    std::lock_guard<std::mutex> lock(outputMutex);
    std::puts(event.dump().c_str());
    std::fflush(stdout);
}
static void require(bool condition, const char *message) {
    if (!condition)
        throw std::runtime_error(message);
}
// Protocol debug dumps may contain session secrets; report failures through structured callbacks instead.
static void protocolLog(const char *, ...) {}
static bool privateAddress(const std::string &address) {
    std::array<unsigned, 4> octets{};
    size_t offset = 0;
    for (size_t i = 0; i < octets.size(); ++i) {
        const auto end = address.find('.', offset);
        if ((i < 3) != (end != std::string::npos))
            return false;
        const size_t count = (end == std::string::npos ? address.size() : end) - offset;
        if (!count || count > 3 || (count > 1 && address[offset] == '0'))
            return false;
        const auto parsed =
            std::from_chars(address.data() + offset, address.data() + offset + count, octets[i]);
        if (parsed.ec != std::errc{} || parsed.ptr != address.data() + offset + count || octets[i] > 255)
            return false;
        offset += count + 1;
    }
    const unsigned a = octets[0], b = octets[1];
    return a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) ||
           (a == 169 && b == 254);
}
static std::vector<unsigned char> unhex(const std::string &text, size_t size) {
    require(text.size() == size * 2, "Invalid key length");
    std::vector<unsigned char> bytes;
    for (size_t i = 0; i < text.size(); i += 2) {
        require(std::isxdigit(static_cast<unsigned char>(text[i])) &&
                    std::isxdigit(static_cast<unsigned char>(text[i + 1])),
                "Invalid hexadecimal key");
        bytes.push_back(static_cast<unsigned char>(std::stoul(text.substr(i, 2), nullptr, 16)));
    }
    return bytes;
}
static int readByte() {
    char ch;
#ifdef _WIN32
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &ch, 1, &count, nullptr) || count != 1)
        return -1;
#else
    if (read(STDIN_FILENO, &ch, 1) != 1)
        return -1;
#endif
    return static_cast<unsigned char>(ch);
}
static std::string readConfig() {
    std::string line;
    for (;;) {
        const int ch = readByte();
        require(ch >= 0, "Missing configuration on stdin");
        if (ch == '\n')
            return line;
        require(line.size() < 16384, "Configuration exceeds 16 KiB");
        line.push_back(static_cast<char>(ch));
    }
}
static bool stopRequested() {
#ifdef _WIN32
    DWORD available = 0;
    if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr))
        return true;
    return available > 0;
#else
    pollfd input{STDIN_FILENO, POLLIN | POLLHUP, 0};
    return poll(&input, 1, 0) > 0;
#endif
}
static std::vector<unsigned char> syntheticH264() {
    std::vector<unsigned char> packet;
    std::vector<unsigned char> rbsp;
    int bitCount = 0;
    auto bit = [&](unsigned value) {
        if (bitCount % 8 == 0)
            rbsp.push_back(0);
        rbsp.back() |= static_cast<unsigned char>((value & 1) << (7 - bitCount % 8));
        ++bitCount;
    };
    auto bits = [&](unsigned value, int count) {
        for (int i = count - 1; i >= 0; --i)
            bit(value >> i);
    };
    auto ue = [&](unsigned value) {
        const unsigned code = value + 1;
        int size = 0;
        for (unsigned n = code; n; n >>= 1)
            ++size;
        for (int i = 1; i < size; ++i)
            bit(0);
        bits(code, size);
    };
    auto finishNal = [&](unsigned char type) {
        bit(1);
        while (bitCount % 8)
            bit(0);
        packet.insert(packet.end(), {0, 0, 0, 1, type});
        int zeros = 0;
        for (unsigned char byte : rbsp) {
            if (zeros >= 2 && byte <= 3) {
                packet.push_back(3);
                zeros = 0;
            }
            packet.push_back(byte);
            zeros = byte == 0 ? zeros + 1 : 0;
        }
        rbsp.clear();
        bitCount = 0;
    };
    // Generate our own baseline-profile 320x240 I_PCM frame, not a downloaded video fixture.
    bits(66, 8);
    bits(0, 8);
    bits(30, 8);
    ue(0);
    ue(0);
    ue(2);
    ue(1);
    bit(0);
    ue(19);
    ue(14);
    bit(1);
    bit(1);
    bit(0);
    bit(0);
    finishNal(0x67);
    ue(0);
    ue(0);
    bit(0);
    bit(0);
    ue(0);
    ue(0);
    ue(0);
    bit(0);
    bits(0, 2);
    ue(0);
    ue(0);
    ue(0);
    bit(1);
    bit(0);
    bit(0);
    finishNal(0x68);
    ue(0);
    ue(2);
    ue(0);
    bits(0, 4);
    ue(0);
    bit(0);
    bit(0);
    ue(0);
    ue(1);
    for (int mb = 0; mb < 20 * 15; ++mb) {
        ue(25);
        while (bitCount % 8)
            bit(0);
        rbsp.insert(rbsp.end(), 256, static_cast<unsigned char>(80 + (mb % 20) * 4));
        rbsp.insert(rbsp.end(), 128, 128);
        bitCount += 384 * 8;
    }
    finishNal(0x65);
    return packet;
}
static void generateIdentity(const std::filesystem::path &directory) {
    std::filesystem::create_directories(directory);
#ifndef _WIN32
    require(chmod(directory.c_str(), 0700) == 0, "Cannot protect identity directory");
#endif
    const auto keyPath = directory / "client-key.pem";
    const auto certPath = directory / "client-cert.pem";
    if (std::filesystem::exists(keyPath) || std::filesystem::exists(certPath)) {
        require(std::filesystem::exists(keyPath) && std::filesystem::exists(certPath),
                "Incomplete identity: restore both original identity files; do not overwrite");
        emit({{"event", "identity"}, {"created", false}});
        return;
    }
    std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> context(
        EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr), EVP_PKEY_CTX_free);
    require(context && EVP_PKEY_keygen_init(context.get()) > 0 &&
                EVP_PKEY_CTX_set_rsa_keygen_bits(context.get(), 2048) > 0,
            "Cannot initialize RSA identity");
    EVP_PKEY *rawKey = nullptr;
    require(EVP_PKEY_keygen(context.get(), &rawKey) > 0, "Cannot create RSA identity");
    std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(rawKey, EVP_PKEY_free);
    std::unique_ptr<X509, decltype(&X509_free)> cert(X509_new(), X509_free);
    require(cert && X509_set_version(cert.get(), 2) == 1, "Cannot create certificate");
    unsigned char serial[16];
    require(RAND_bytes(serial, sizeof(serial)) == 1, "Random number generation failed");
    serial[0] &= 0x7f;
    std::unique_ptr<BIGNUM, decltype(&BN_free)> number(BN_bin2bn(serial, sizeof(serial), nullptr), BN_free);
    require(number && BN_to_ASN1_INTEGER(number.get(), X509_get_serialNumber(cert.get())),
            "Cannot set certificate serial");
    require(X509_gmtime_adj(X509_getm_notBefore(cert.get()), -86400) &&
                X509_gmtime_adj(X509_getm_notAfter(cert.get()), 60L * 60 * 24 * 365 * 10) &&
                X509_set_pubkey(cert.get(), key.get()) == 1,
            "Cannot set certificate lifetime");
    auto *name = X509_get_subject_name(cert.get());
    require(
        X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
                                   reinterpret_cast<const unsigned char *>("SolunaRemote"), -1, -1, 0) == 1 &&
            X509_set_issuer_name(cert.get(), name) == 1 && X509_sign(cert.get(), key.get(), EVP_sha256()) > 0,
        "Cannot sign client certificate");
    auto writePem = [](const std::filesystem::path &file, auto writer) {
        std::unique_ptr<BIO, decltype(&BIO_free)> memory(BIO_new(BIO_s_mem()), BIO_free);
        require(memory && writer(memory.get()) == 1, "Cannot serialize client identity");
        char *data = nullptr;
        const long length = BIO_get_mem_data(memory.get(), &data);
        require(length > 0 && data != nullptr, "Empty serialized client identity");
#ifdef _WIN32
        FILE *raw = nullptr;
        const auto error = _wfopen_s(&raw, file.c_str(), L"wbx");
        require(error == 0, "Cannot create identity file (existing files are never overwritten)");
#else
        FILE *raw = std::fopen(file.c_str(), "wbx");
#endif
        require(raw != nullptr, "Cannot create identity file (existing files are never overwritten)");
        std::unique_ptr<FILE, decltype(&std::fclose)> output(raw, std::fclose);
#ifndef _WIN32
        require(fchmod(fileno(raw), 0600) == 0, "Cannot protect identity file");
#endif
        require(std::fwrite(data, 1, static_cast<size_t>(length), raw) == static_cast<size_t>(length) &&
                    std::fflush(raw) == 0,
                "Cannot write identity file");
    };
    writePem(keyPath, [&](BIO *bio) {
        return PEM_write_bio_PrivateKey(bio, key.get(), nullptr, nullptr, 0, nullptr, nullptr);
    });
    writePem(certPath, [&](BIO *bio) { return PEM_write_bio_X509(bio, cert.get()); });
    emit({{"event", "identity"}, {"created", true}});
}

struct Picture {
    std::vector<unsigned char> pixels;
    int width = 0;
    int height = 0;
    bool ready = false;
};
struct Player {
    std::atomic<bool> quit{false}, connected{false}, startingDone{false};
    std::atomic<int> error{0};
    std::atomic<unsigned long long> decoded{0}, rendered{0}, audioPackets{0};
    std::atomic<unsigned long long> videoBytes{0}, connectedTicks{0};
    unsigned long long keyboardEvents = 0;
    std::atomic<int> connectionQuality{0};
    SessionChrome chrome;
    Uint64 lastPaint = 0;
    std::mutex frameMutex;
    Picture picture;
    AVCodecContext *decoder = nullptr;
    AVFrame *frame = nullptr;
    AVFrame *softwareFrame = nullptr;
    SwsContext *converter = nullptr;
    AVPixelFormat hardwareFormat = AV_PIX_FMT_NONE;
    OpusMSDecoder *opus = nullptr;
    std::atomic<SDL_AudioDeviceID> audio{0};
    std::atomic<bool> audioMuted{false};
    int audioSamples = 0;
    SDL_Window *window = nullptr;
    SDL_Renderer *renderer = nullptr;
    SDL_Texture *texture = nullptr;
    SDL_Rect viewport{0, 0, 1, 1};
    std::set<int> pressedKeys;
    std::set<int> pressedButtons;
    bool useHardware = true;
    bool sawFrame = false;
    int textureWidth = 0, textureHeight = 0;

    void fail(const std::string &message) {
        emit({{"event", "error"}, {"message", message}});
        error = 1;
        quit = true;
    }
    static Player *current;
    static AVPixelFormat chooseFormat(AVCodecContext *, const AVPixelFormat *formats) {
        for (auto *format = formats; *format != AV_PIX_FMT_NONE; ++format)
            if (*format == current->hardwareFormat)
                return *format;
        emit({{"event", "warning"},
              {"message", "Hardware pixel format unavailable; using software decoding"}});
        for (auto *format = formats; *format != AV_PIX_FMT_NONE; ++format)
            if (!(av_pix_fmt_desc_get(*format)->flags & AV_PIX_FMT_FLAG_HWACCEL))
                return *format;
        return AV_PIX_FMT_NONE;
    }
    static int videoSetup(int format, int, int, int, void *, int) {
        auto &p = *current;
        const AVCodecID id = (format & VIDEO_FORMAT_MASK_H264)   ? AV_CODEC_ID_H264
                             : (format & VIDEO_FORMAT_MASK_H265) ? AV_CODEC_ID_HEVC
                                                                 : AV_CODEC_ID_AV1;
        const auto *codec = avcodec_find_decoder(id);
        if (!codec) {
            p.fail("Requested FFmpeg video decoder is unavailable");
            return -1;
        }
        p.decoder = avcodec_alloc_context3(codec);
        if (!p.decoder)
            return -1;
        p.decoder->thread_count = 1;
        p.decoder->flags |= AV_CODEC_FLAG_LOW_DELAY;
        if (p.useHardware) {
#ifdef _WIN32
            const auto type = AV_HWDEVICE_TYPE_D3D11VA;
#elif defined(__APPLE__)
            const auto type = AV_HWDEVICE_TYPE_VIDEOTOOLBOX;
#else
            const auto type = AV_HWDEVICE_TYPE_VAAPI;
#endif
            for (int i = 0; const auto *config = avcodec_get_hw_config(codec, i); ++i) {
                if (config->device_type != type ||
                    !(config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX))
                    continue;
                if (av_hwdevice_ctx_create(&p.decoder->hw_device_ctx, type, nullptr, nullptr, 0) == 0) {
                    p.hardwareFormat = config->pix_fmt;
                    p.decoder->get_format = chooseFormat;
                    emit({{"event", "decoder"}, {"backend", av_hwdevice_get_type_name(type)}});
                } else
                    emit({{"event", "warning"},
                          {"message", "Hardware decoder unavailable; using software decoding"}});
                break;
            }
        }
        if (avcodec_open2(p.decoder, codec, nullptr) < 0) {
            p.fail("Cannot open FFmpeg decoder");
            return -1;
        }
        p.frame = av_frame_alloc();
        p.softwareFrame = av_frame_alloc();
        if (!p.frame || !p.softwareFrame) {
            p.fail("Cannot allocate video frames");
            return -1;
        }
        emit({{"event", "video"}, {"codec", codec->name}});
        return 0;
    }
    static int submit(PDECODE_UNIT unit) {
        auto &p = *current;
        if (p.quit)
            return DR_OK;
        p.videoBytes += unit->fullLength;
        if (unit->fullLength <= 0 || unit->fullLength > 16 * 1024 * 1024)
            return DR_NEED_IDR;
        AVPacket *packet = av_packet_alloc();
        if (!packet || av_new_packet(packet, unit->fullLength) < 0) {
            av_packet_free(&packet);
            p.fail("Cannot allocate compressed video frame");
            return DR_NEED_IDR;
        }
        int offset = 0;
        for (auto *entry = unit->bufferList; entry; entry = entry->next) {
            if (entry->length < 0 || entry->length > unit->fullLength - offset) {
                av_packet_free(&packet);
                return DR_NEED_IDR;
            }
            std::memcpy(packet->data + offset, entry->data, entry->length);
            offset += entry->length;
        }
        if (offset != unit->fullLength) {
            av_packet_free(&packet);
            return DR_NEED_IDR;
        }
        const int result = avcodec_send_packet(p.decoder, packet);
        av_packet_free(&packet);
        if (result < 0) {
            emit({{"event", "warning"}, {"message", "Video decode failed; requesting a fresh keyframe"}});
            avcodec_flush_buffers(p.decoder);
            return DR_NEED_IDR;
        }
        while (true) {
            int rc = avcodec_receive_frame(p.decoder, p.frame);
            if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF)
                break;
            if (rc < 0)
                return DR_NEED_IDR;
            AVFrame *source = p.frame;
            if (source->format == p.hardwareFormat) {
                av_frame_unref(p.softwareFrame);
                if (av_hwframe_transfer_data(p.softwareFrame, source, 0) < 0) {
                    p.fail("Cannot transfer hardware-decoded video frame");
                    return DR_NEED_IDR;
                }
                source = p.softwareFrame;
            }
            if (source->width <= 0 || source->height <= 0 || source->width > 7680 || source->height > 4320) {
                p.fail("Unsupported decoded frame dimensions");
                return DR_NEED_IDR;
            }
            p.converter = sws_getCachedContext(p.converter, source->width, source->height,
                                               static_cast<AVPixelFormat>(source->format), source->width,
                                               source->height, AV_PIX_FMT_YUV420P, SWS_FAST_BILINEAR, nullptr,
                                               nullptr, nullptr);
            if (!p.converter) {
                p.fail("Cannot create video colour converter");
                return DR_NEED_IDR;
            }
            const int size = av_image_get_buffer_size(AV_PIX_FMT_YUV420P, source->width, source->height, 1);
            std::vector<unsigned char> pixels(size);
            unsigned char *planes[4];
            int lines[4];
            av_image_fill_arrays(planes, lines, pixels.data(), AV_PIX_FMT_YUV420P, source->width,
                                 source->height, 1);
            if (sws_scale(p.converter, source->data, source->linesize, 0, source->height, planes, lines) <
                0) {
                p.fail("Cannot convert decoded video");
                return DR_NEED_IDR;
            }
            {
                std::lock_guard<std::mutex> lock(p.frameMutex);
                p.picture = {std::move(pixels), source->width, source->height, true};
            }
            ++p.decoded;
            av_frame_unref(p.frame);
        }
        return DR_OK;
    }
    static int audioInit(int, const POPUS_MULTISTREAM_CONFIGURATION config, void *, int) {
        auto &p = *current;
        if (config->channelCount != 2 || config->samplesPerFrame <= 0 || config->samplesPerFrame > 5760)
            return -1;
        int error;
        p.opus = opus_multistream_decoder_create(config->sampleRate, 2, config->streams,
                                                 config->coupledStreams, config->mapping, &error);
        if (!p.opus || error != OPUS_OK)
            return -1;
        p.audioSamples = config->samplesPerFrame;
        SDL_AudioSpec desired{};
        desired.freq = config->sampleRate;
        desired.format = AUDIO_S16SYS;
        desired.channels = 2;
        desired.samples = 512;
        p.audio = SDL_OpenAudioDevice(nullptr, 0, &desired, nullptr, 0);
        if (!p.audio) {
            p.fail(std::string("Cannot open stereo audio output: ") + SDL_GetError());
            return -1;
        }
        SDL_PauseAudioDevice(p.audio, p.audioMuted ? 1 : 0);
        return 0;
    }
    static void audioSubmit(char *data, int length) {
        auto &p = *current;
        if (p.quit)
            return;
        std::vector<opus_int16> samples(static_cast<size_t>(p.audioSamples) * 2);
        int decoded = opus_multistream_decode(p.opus, reinterpret_cast<unsigned char *>(data), length,
                                              samples.data(), p.audioSamples, 0);
        if (decoded < 0) {
            emit({{"event", "warning"}, {"message", "Invalid Opus audio packet"}});
            return;
        }
        // Bound latency: discard an old queue rather than accumulating delayed audio.
        if (SDL_GetQueuedAudioSize(p.audio) > 48000 * 2 * sizeof(opus_int16) / 10)
            SDL_ClearQueuedAudio(p.audio);
        if (SDL_QueueAudio(p.audio, samples.data(), decoded * 2 * sizeof(opus_int16)) != 0)
            p.fail(std::string("Cannot queue audio: ") + SDL_GetError());
        ++p.audioPackets;
    }
    static int virtualKey(SDL_Keycode key) {
        if (key >= SDLK_a && key <= SDLK_z)
            return 0x41 + (key - SDLK_a);
        if (key >= SDLK_0 && key <= SDLK_9)
            return 0x30 + (key - SDLK_0);
        if (key >= SDLK_F1 && key <= SDLK_F12)
            return 0x70 + (key - SDLK_F1);
        switch (key) {
        case SDLK_BACKSPACE:
            return 0x08;
        case SDLK_TAB:
            return 0x09;
        case SDLK_RETURN:
            return 0x0d;
        case SDLK_ESCAPE:
            return 0x1b;
        case SDLK_SPACE:
            return 0x20;
        case SDLK_PAGEUP:
            return 0x21;
        case SDLK_PAGEDOWN:
            return 0x22;
        case SDLK_END:
            return 0x23;
        case SDLK_HOME:
            return 0x24;
        case SDLK_LEFT:
            return 0x25;
        case SDLK_UP:
            return 0x26;
        case SDLK_RIGHT:
            return 0x27;
        case SDLK_DOWN:
            return 0x28;
        case SDLK_INSERT:
            return 0x2d;
        case SDLK_DELETE:
            return 0x2e;
        case SDLK_LSHIFT:
            return 0xa0;
        case SDLK_RSHIFT:
            return 0xa1;
        case SDLK_LCTRL:
            return 0xa2;
        case SDLK_RCTRL:
            return 0xa3;
        case SDLK_LALT:
            return 0xa4;
        case SDLK_RALT:
            return 0xa5;
        case SDLK_LGUI:
            return 0x5b;
        case SDLK_RGUI:
            return 0x5c;
        case SDLK_CAPSLOCK:
            return 0x14;
        case SDLK_SEMICOLON:
            return 0xba;
        case SDLK_EQUALS:
            return 0xbb;
        case SDLK_COMMA:
            return 0xbc;
        case SDLK_MINUS:
            return 0xbd;
        case SDLK_PERIOD:
            return 0xbe;
        case SDLK_SLASH:
            return 0xbf;
        case SDLK_BACKQUOTE:
            return 0xc0;
        case SDLK_LEFTBRACKET:
            return 0xdb;
        case SDLK_BACKSLASH:
            return 0xdc;
        case SDLK_RIGHTBRACKET:
            return 0xdd;
        case SDLK_QUOTE:
            return 0xde;
        default:
            return 0;
        }
    }
    static int mouseButton(Uint8 button) {
        switch (button) {
        case SDL_BUTTON_LEFT:
            return BUTTON_LEFT;
        case SDL_BUTTON_MIDDLE:
            return BUTTON_MIDDLE;
        case SDL_BUTTON_RIGHT:
            return BUTTON_RIGHT;
        case SDL_BUTTON_X1:
            return BUTTON_X1;
        case SDL_BUTTON_X2:
            return BUTTON_X2;
        default:
            return 0;
        }
    }
    void releaseInput() {
        for (int key : pressedKeys)
            LiSendKeyboardEvent(static_cast<short>(0x8000 | key), KEY_ACTION_UP, 0);
        for (int button : pressedButtons)
            LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, button);
        pressedKeys.clear();
        pressedButtons.clear();
    }
    void handle(const SDL_Event &event, bool selfTest) {
        if (event.type == SDL_QUIT) {
            quit = true;
            return;
        }
        if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_F12 &&
            (event.key.keysym.mod & KMOD_CTRL) && (event.key.keysym.mod & KMOD_ALT)) {
            quit = true;
            return;
        }
        const auto action = chrome.handle(event, window);
        if (selfTest && event.type == SDL_MOUSEBUTTONDOWN)
            emit({{"event", "self-test-click"},
                  {"x", event.button.x},
                  {"y", event.button.y},
                  {"action", action},
                  {"panel", chrome.panel},
                  {"performance", chrome.performance},
                  {"muted", chrome.muted},
                  {"display", chrome.selectedDisplay},
                  {"fullscreen", (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN_DESKTOP) != 0}});
        if (action != SessionChrome::Pass) {
            releaseInput();
            if (action == SessionChrome::Disconnect)
                quit = true;
            if (action == SessionChrome::DisplayChanged) {
                if (!selfTest && connected) {
                    const short key = static_cast<short>(0x8000 | (0x70 + chrome.selectedDisplay - 1));
                    const char modifiers = MODIFIER_CTRL | MODIFIER_ALT | MODIFIER_SHIFT;
                    if (LiSendKeyboardEvent(key, KEY_ACTION_DOWN, modifiers) != 0 ||
                        LiSendKeyboardEvent(key, KEY_ACTION_UP, modifiers) != 0)
                        fail("Cannot queue remote display switch");
                    else
                        emit({{"event", "display-switch-requested"},
                              {"display", chrome.selectedDisplay},
                              {"hotkey", "Ctrl+Alt+Shift+F" + std::to_string(chrome.selectedDisplay)}});
                }
            }
            if (action == SessionChrome::AudioChanged) {
                audioMuted = chrome.muted;
                if (audio)
                    SDL_PauseAudioDevice(audio, audioMuted ? 1 : 0);
            }
            return;
        }
        if (selfTest || !connected)
            return;
        if (event.type == SDL_WINDOWEVENT && event.window.event == SDL_WINDOWEVENT_FOCUS_LOST)
            releaseInput();
        if ((event.type == SDL_KEYDOWN || event.type == SDL_KEYUP) && !event.key.repeat) {
            int key = virtualKey(event.key.keysym.sym);
            if (!key)
                return;
            if (event.type == SDL_KEYDOWN)
                pressedKeys.insert(key);
            else
                pressedKeys.erase(key);
            char modifiers = 0;
            if (event.key.keysym.mod & KMOD_SHIFT)
                modifiers |= MODIFIER_SHIFT;
            if (event.key.keysym.mod & KMOD_CTRL)
                modifiers |= MODIFIER_CTRL;
            if (event.key.keysym.mod & KMOD_ALT)
                modifiers |= MODIFIER_ALT;
            if (event.key.keysym.mod & KMOD_GUI)
                modifiers |= MODIFIER_META;
            const int result =
                LiSendKeyboardEvent(static_cast<short>(0x8000 | key),
                                    event.type == SDL_KEYDOWN ? KEY_ACTION_DOWN : KEY_ACTION_UP, modifiers);
            if (result != 0)
                fail("Cannot queue remote keyboard input");
            else
                ++keyboardEvents;
        } else if (event.type == SDL_MOUSEMOTION) {
            const int x = event.motion.x - viewport.x, y = event.motion.y - viewport.y;
            if (x >= 0 && y >= 0 && x < viewport.w && y < viewport.h)
                LiSendMousePositionEvent(static_cast<short>(x), static_cast<short>(y),
                                         static_cast<short>(viewport.w), static_cast<short>(viewport.h));
        } else if (event.type == SDL_MOUSEBUTTONDOWN || event.type == SDL_MOUSEBUTTONUP) {
            int button = mouseButton(event.button.button);
            if (!button)
                return;
            if (event.type == SDL_MOUSEBUTTONDOWN &&
                (event.button.x < viewport.x || event.button.y < viewport.y ||
                 event.button.x >= viewport.x + viewport.w || event.button.y >= viewport.y + viewport.h))
                return;
            if (event.type == SDL_MOUSEBUTTONUP && !pressedButtons.count(button))
                return;
            if (event.type == SDL_MOUSEBUTTONDOWN)
                pressedButtons.insert(button);
            else
                pressedButtons.erase(button);
            LiSendMouseButtonEvent(
                event.type == SDL_MOUSEBUTTONDOWN ? BUTTON_ACTION_PRESS : BUTTON_ACTION_RELEASE, button);
        } else if (event.type == SDL_MOUSEWHEEL) {
            int scroll = event.wheel.y * 120;
            if (event.wheel.direction == SDL_MOUSEWHEEL_FLIPPED)
                scroll = -scroll;
            LiSendHighResScrollEvent(static_cast<short>(std::clamp(scroll, -32767, 32767)));
        }
    }
    void draw() {
        Picture next;
        {
            std::lock_guard<std::mutex> lock(frameMutex);
            if (picture.ready) {
                std::swap(next, picture);
                picture.ready = false;
            }
        }
        const bool newFrame = !next.pixels.empty();
        if (!newFrame && SDL_GetTicks64() - lastPaint < 33)
            return;
        lastPaint = SDL_GetTicks64();
        if (newFrame && (!texture || textureWidth != next.width || textureHeight != next.height)) {
            SDL_DestroyTexture(texture);
            texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_IYUV, SDL_TEXTUREACCESS_STREAMING,
                                        next.width, next.height);
            textureWidth = next.width;
            textureHeight = next.height;
            if (!texture) {
                fail(std::string("Cannot create video texture: ") + SDL_GetError());
                return;
            }
        }
        if (newFrame) {
            unsigned char *planes[4];
            int lines[4];
            av_image_fill_arrays(planes, lines, next.pixels.data(), AV_PIX_FMT_YUV420P, next.width,
                                 next.height, 1);
            if (SDL_UpdateYUVTexture(texture, nullptr, planes[0], lines[0], planes[1], lines[1], planes[2],
                                     lines[2]) != 0) {
                fail(std::string("Video texture update failed: ") + SDL_GetError());
                return;
            }
        }
        int w, h;
        SDL_GetWindowSize(window, &w, &h);
        const int contentHeight = std::max(1, h - chrome.height());
        double scale = std::min(static_cast<double>(w) / std::max(1, textureWidth),
                                static_cast<double>(contentHeight) / std::max(1, textureHeight));
        viewport.w = std::max(1, static_cast<int>(textureWidth * scale));
        viewport.h = std::max(1, static_cast<int>(textureHeight * scale));
        viewport.x = (w - viewport.w) / 2;
        viewport.y = chrome.height() + (contentHeight - viewport.h) / 2;
        SDL_SetRenderDrawColor(renderer, 12, 16, 24, 255);
        if (SDL_RenderClear(renderer) != 0 ||
            (texture && SDL_RenderCopy(renderer, texture, nullptr, &viewport) != 0)) {
            fail(std::string("Video presentation failed: ") + SDL_GetError());
            return;
        }
        chrome.videoWidth = textureWidth;
        chrome.videoHeight = textureHeight;
        chrome.connectedAt = connectedTicks;
        chrome.quality = connectionQuality;
        chrome.draw(renderer, window, connected || chrome.connectedAt);
        SDL_RenderPresent(renderer);
        if (newFrame)
            ++rendered;
        if (newFrame && !sawFrame) {
            sawFrame = true;
            emit({{"event", "first-frame"}, {"width", next.width}, {"height", next.height}});
        }
    }
    int run(const Json &config) {
        current = this;
        const bool selfTest = config.value("selfTest", false);
        const int selfTestSeconds = config.value("selfTestSeconds", 3);
        require(selfTestSeconds >= 1 && selfTestSeconds <= 30, "Invalid self-test duration");
        const int width = config.value("width", 1280), height = config.value("height", 720);
        const int fps = config.value("fps", 60), bitrate = config.value("bitrate", 20000);
        require(width >= 320 && width <= 3840 && height >= 240 && height <= 2160 && fps >= 30 && fps <= 120 &&
                    bitrate >= 1000 && bitrate <= 150000,
                "Invalid stream dimensions, FPS or bitrate");
        useHardware = config.value("decoder", std::string("auto")) != "software";
        const std::string displayMode = config.value("displayMode", std::string("windowed"));
        require(displayMode == "windowed" || displayMode == "borderless" || displayMode == "fullscreen",
                "Invalid display mode");
#ifdef _WIN32
        if (!SDL_SetHint(SDL_HINT_WINDOWS_DPI_AWARENESS, "permonitorv2"))
            emit({{"event", "warning"}, {"message", "Per-monitor session DPI awareness unavailable"}});
#endif
        require(SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_EVENTS) == 0, SDL_GetError());
        window = SDL_CreateWindow("SolunaRemote - Ctrl+Alt+F12 to disconnect", SDL_WINDOWPOS_CENTERED,
                                  SDL_WINDOWPOS_CENTERED, std::min(width, 1280), std::min(height, 720),
                                  SDL_WINDOW_RESIZABLE);
        require(window != nullptr, SDL_GetError());
        SDL_SetWindowMinimumSize(window, 860, 480);
        chrome.name = config.value("deviceName", std::string("SolunaRemote"));
        require(!chrome.name.empty() && chrome.name.size() <= 256, "Invalid remote device name");
        chrome.displayCount = config.value("displayCount", 1);
        require(chrome.displayCount >= 1 && chrome.displayCount <= 32, "Invalid remote display count");
        chrome.initialize(window);
        if (displayMode != "windowed")
            require(SDL_SetWindowFullscreen(window, displayMode == "fullscreen"
                                                        ? SDL_WINDOW_FULLSCREEN
                                                        : SDL_WINDOW_FULLSCREEN_DESKTOP) == 0,
                    SDL_GetError());
        renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
        if (!renderer) {
            emit({{"event", "warning"}, {"message", "Accelerated SDL renderer unavailable; using software"}});
            renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
        }
        require(renderer != nullptr, SDL_GetError());
        SDL_SetRenderDrawColor(renderer, 12, 16, 24, 255);
        SDL_SetYUVConversionMode(SDL_YUV_CONVERSION_BT709);
        SDL_RenderClear(renderer);
        SDL_RenderPresent(renderer);
        STREAM_CONFIGURATION stream{};
        SERVER_INFORMATION server{};
        std::string address, version, gfe, rtsp;
        std::thread connection;
        if (!selfTest) {
            address = config.at("address").get<std::string>();
            require(privateAddress(address), "Only numeric LAN IPv4 hosts are allowed");
            version = config.at("appVersion").get<std::string>();
            gfe = config.value("gfeVersion", std::string());
            rtsp = config.at("rtspUrl").get<std::string>();
            const std::string prefix = rtsp.rfind("rtspenc://", 0) == 0 ? "rtspenc://" : "rtsp://";
            const std::string authority = prefix + address + ":";
            require(rtsp.rfind(authority, 0) == 0, "RTSP target must match the validated LAN host");
            const auto portEnd = rtsp.find_first_not_of("0123456789", authority.size());
            const std::string port = rtsp.substr(authority.size(), portEnd - authority.size());
            require(!port.empty() && port.size() <= 5 && std::stoi(port) >= 1024 &&
                        std::stoi(port) <= 65535 && (portEnd == std::string::npos || rtsp[portEnd] == '/') &&
                        rtsp.find_first_of("@# \t\r\n") == std::string::npos &&
                        rtsp.find('\0') == std::string::npos,
                    "Invalid RTSP port or URL authority");
            LiInitializeServerInformation(&server);
            server.address = address.c_str();
            server.serverInfoAppVersion = version.c_str();
            server.serverInfoGfeVersion = gfe.empty() ? nullptr : gfe.c_str();
            server.rtspSessionUrl = rtsp.c_str();
            server.serverCodecModeSupport = config.value("serverCodecs", 1);
            LiInitializeStreamConfiguration(&stream);
            stream.width = width;
            stream.height = height;
            stream.fps = fps;
            stream.bitrate = bitrate;
            stream.packetSize = 1392;
            stream.streamingRemotely = STREAM_CFG_LOCAL;
            stream.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
            stream.supportedVideoFormats = VIDEO_FORMAT_H264;
            const auto codec = config.value("codec", std::string("auto"));
            if (codec == "HEVC")
                stream.supportedVideoFormats = VIDEO_FORMAT_H265;
            else if (codec == "AV1")
                stream.supportedVideoFormats = VIDEO_FORMAT_AV1_MAIN8;
            else
                require(codec == "auto" || codec == "H.264", "Unsupported video codec");
            stream.encryptionFlags = ENCFLG_ALL;
            stream.colorSpace = COLORSPACE_REC_709;
            auto key = unhex(config.at("key").get<std::string>(), 16);
            auto iv = unhex(config.at("iv").get<std::string>(), 16);
            std::memcpy(stream.remoteInputAesKey, key.data(), key.size());
            std::memcpy(stream.remoteInputAesIv, iv.data(), iv.size());
            connection = std::thread([&] {
                CONNECTION_LISTENER_CALLBACKS callbacks{};
                LiInitializeConnectionCallbacks(&callbacks);
                callbacks.logMessage = protocolLog;
                callbacks.stageStarting = [](int stage) {
                    emit({{"event", "stage"}, {"name", LiGetStageName(stage)}});
                };
                callbacks.stageFailed = [](int stage, int code) {
                    emit({{"event", "error"}, {"message", LiGetStageName(stage)}, {"code", code}});
                    current->error = code ? code : 1;
                    current->quit = true;
                };
                callbacks.connectionStarted = [] {
                    current->connected = true;
                    current->connectedTicks = SDL_GetTicks64();
                    emit({{"event", "connected"}});
                };
                callbacks.connectionStatusUpdate = [](int status) { current->connectionQuality = status; };
                callbacks.connectionTerminated = [](int code) {
                    current->error = code;
                    current->quit = true;
                    emit({{"event", "terminated"}, {"code", code}});
                };
                DECODER_RENDERER_CALLBACKS video{};
                LiInitializeVideoCallbacks(&video);
                video.setup = videoSetup;
                video.submitDecodeUnit = submit;
                AUDIO_RENDERER_CALLBACKS audioCallbacks{};
                LiInitializeAudioCallbacks(&audioCallbacks);
                audioCallbacks.init = audioInit;
                audioCallbacks.decodeAndPlaySample = audioSubmit;
                int result = LiStartConnection(&server, &stream, &callbacks, &video, &audioCallbacks, nullptr,
                                               0, nullptr, 0);
                current->startingDone = true;
                if (result != 0) {
                    current->error = result;
                    current->quit = true;
                }
            });
        }
        std::vector<unsigned char> selfTestVideo;
        std::vector<unsigned char> selfTestAudio;
        if (selfTest) {
            require(videoSetup(VIDEO_FORMAT_H264, 320, 240, 30, nullptr, 0) == 0,
                    "Self-test decoder initialization failed");
            selfTestVideo = syntheticH264();
            OPUS_MULTISTREAM_CONFIGURATION opusConfig{};
            opusConfig.sampleRate = 48000;
            opusConfig.channelCount = 2;
            opusConfig.streams = 1;
            opusConfig.coupledStreams = 1;
            opusConfig.samplesPerFrame = 240;
            opusConfig.mapping[0] = 0;
            opusConfig.mapping[1] = 1;
            require(audioInit(AUDIO_CONFIGURATION_STEREO, &opusConfig, nullptr, 0) == 0,
                    "Self-test audio initialization failed");
            int result;
            std::unique_ptr<OpusMSEncoder, decltype(&opus_multistream_encoder_destroy)> encoder(
                opus_multistream_encoder_create(48000, 2, 1, 1, opusConfig.mapping,
                                                OPUS_APPLICATION_RESTRICTED_LOWDELAY, &result),
                opus_multistream_encoder_destroy);
            require(encoder && result == OPUS_OK, "Cannot initialize self-test Opus encoder");
            std::vector<opus_int16> silence(480, 0);
            selfTestAudio.resize(1500);
            result = opus_multistream_encode(encoder.get(), silence.data(), 240, selfTestAudio.data(), 1500);
            require(result > 0, "Cannot encode self-test silence");
            selfTestAudio.resize(result);
        }
        const auto start = std::chrono::steady_clock::now();
        auto lastStats = start;
        unsigned long long lastRendered = 0, lastBytes = 0;
        auto lastVideo = start - std::chrono::seconds(1);
        auto lastAudio = lastVideo;
        while (!quit) {
            try {
                SDL_Event event;
                while (SDL_PollEvent(&event))
                    handle(event, selfTest);
                if (!selfTest && stopRequested())
                    quit = true;
                auto now = std::chrono::steady_clock::now();
                if (selfTest) {
                    if (now - lastVideo >= std::chrono::milliseconds(33)) {
                        LENTRY entry{};
                        entry.data = reinterpret_cast<char *>(selfTestVideo.data());
                        entry.length = static_cast<int>(selfTestVideo.size());
                        DECODE_UNIT unit{};
                        unit.fullLength = entry.length;
                        unit.bufferList = &entry;
                        unit.frameType = FRAME_TYPE_IDR;
                        require(submit(&unit) == DR_OK, "Cannot decode synthetic self-test H.264");
                        lastVideo = now;
                    }
                    if (now - lastAudio >= std::chrono::milliseconds(5)) {
                        audioSubmit(reinterpret_cast<char *>(selfTestAudio.data()),
                                    static_cast<int>(selfTestAudio.size()));
                        lastAudio = now;
                    }
                    if (now - start > std::chrono::seconds(selfTestSeconds))
                        quit = true;
                }
                draw();
                if (now - lastStats > std::chrono::seconds(1)) {
                    const double elapsed = std::chrono::duration<double>(now - lastStats).count();
                    const auto frames = rendered.load(), bytes = videoBytes.load();
                    chrome.measuredFps = (frames - lastRendered) / elapsed;
                    chrome.videoMbps = (bytes - lastBytes) * 8.0 / elapsed / 1000000.0;
                    chrome.audioPackets = audioPackets;
                    uint32_t variance = 0;
                    chrome.hasRtt = !selfTest && connected && LiGetEstimatedRttInfo(&chrome.rtt, &variance);
                    lastRendered = frames;
                    lastBytes = bytes;
                    emit({{"event", "stats"},
                          {"decoded", decoded.load()},
                          {"rendered", rendered.load()},
                          {"audioPackets", audioPackets.load()},
                          {"keyboardEvents", keyboardEvents}});
                    lastStats = now;
                }
                if (!selfTest && now - start > std::chrono::seconds(30) && !sawFrame)
                    fail("No rendered video within 30 seconds; check Sunshine capture, encoder and UDP "
                         "firewall");
                SDL_Delay(2);
            } catch (const std::exception &exception) {
                fail(exception.what());
            }
        }
        if (!selfTest) {
            while (!startingDone) {
                LiInterruptConnection();
                SDL_Delay(5);
            }
            connection.join();
            if (connected) {
                releaseInput();
                LiStopConnection();
            }
            connected = false;
        }
        emit({{"event", "stopped"},
              {"decoded", decoded.load()},
              {"rendered", rendered.load()},
              {"audioPackets", audioPackets.load()},
              {"selfTest", selfTest},
              {"controls",
               {{"performance", chrome.performance},
                {"panel", chrome.panel},
                {"muted", chrome.muted},
                {"display", chrome.selectedDisplay},
                {"displayCount", chrome.displayCount}}}});
        return error == 0 ? 0 : 1;
    }
    ~Player() {
        if (audio)
            SDL_CloseAudioDevice(audio);
        if (opus)
            opus_multistream_decoder_destroy(opus);
        av_frame_free(&frame);
        av_frame_free(&softwareFrame);
        avcodec_free_context(&decoder);
        sws_freeContext(converter);
        chrome.release();
        SDL_DestroyTexture(texture);
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        SDL_Quit();
    }
};
Player *Player::current = nullptr;

#ifdef _WIN32
int wmain(int argc, wchar_t **wideArgs) {
#else
int main(int argc, char **argv) {
#endif
    SDL_SetMainReady();
    av_log_set_level(AV_LOG_ERROR);
    try {
#ifdef _WIN32
        std::vector<std::string> arguments;
        std::vector<char *> pointers;
        for (int i = 0; i < argc; ++i) {
            const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wideArgs[i], -1, nullptr, 0,
                                                   nullptr, nullptr);
            require(length > 0, "Cannot decode Unicode command-line arguments");
            std::string argument(length, '\0');
            require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wideArgs[i], -1, argument.data(),
                                        length, nullptr, nullptr) > 0,
                    "Cannot decode Unicode command-line arguments");
            argument.pop_back();
            arguments.push_back(std::move(argument));
        }
        for (auto &argument : arguments)
            pointers.push_back(argument.data());
        char **argv = pointers.data();
#endif
        if (argc == 3 && std::string(argv[1]) == "--identity") {
            generateIdentity(std::filesystem::u8path(argv[2]));
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--version") {
            emit({{"event", "version"}, {"version", "0.4.0"}, {"qt", false}});
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--capabilities") {
            emit({{"event", "capabilities"},
                  {"protocol", 1},
                  {"launchParams", LiGetLaunchUrlQueryParameters()}});
            return 0;
        }
        Player player;
        if (argc == 2 && std::string(argv[1]) == "--self-test")
            return player.run({{"selfTest", true}, {"displayMode", "windowed"}, {"decoder", "software"}});
        require(argc == 1,
                "Usage: soluna-stream [--identity DIRECTORY|--self-test|--version]; stream config on stdin");
        return player.run(Json::parse(readConfig()));
    } catch (const std::exception &error) {
        emit({{"event", "error"}, {"message", error.what()}});
        return 1;
    }
}

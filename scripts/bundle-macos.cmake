if(NOT APP OR NOT NATIVE)
    message(FATAL_ERROR "APP and NATIVE are required")
endif()

set(_contents "${APP}/Contents")
set(_resources "${_contents}/Resources")
set(_host_resources "${_resources}/resources/host")
set(_archive "${_host_resources}/soluna-host.zip")
set(_manifest "${_host_resources}/soluna-host.zip.json")
set(_stage "${_resources}/.soluna-host")
set(_host "${_contents}/MacOS/soluna-host")

if(NOT EXISTS "${_archive}" OR NOT EXISTS "${_manifest}")
    message(FATAL_ERROR "Missing locally built Soluna host archive")
endif()

file(READ "${_manifest}" _manifest_json)
string(JSON _expected_cdhash GET "${_manifest_json}" cdhash)
file(ARCHIVE_EXTRACT INPUT "${_archive}" DESTINATION "${_stage}")
set(_payload "${_stage}/soluna-host")
if(NOT EXISTS "${_payload}/soluna-host" OR
   NOT EXISTS "${_payload}/assets/desktop.png" OR
   NOT EXISTS "${_payload}/assets/box.png")
    message(FATAL_ERROR "The embedded Soluna host archive is incomplete")
endif()

file(MAKE_DIRECTORY "${_contents}/Frameworks" "${_resources}/assets")
file(COPY "${_payload}/soluna-host" DESTINATION "${_contents}/MacOS")
file(COPY "${_payload}/assets/" DESTINATION "${_resources}/assets")
if(EXISTS "${_payload}/Frameworks")
    file(COPY "${_payload}/Frameworks/" DESTINATION "${_contents}/Frameworks")
endif()
file(REMOVE_RECURSE "${_stage}")

file(CREATE_LINK "../../Frameworks" "${_resources}/resources/Frameworks"
    SYMBOLIC RESULT _link_status)
if(NOT _link_status STREQUAL "0")
    message(FATAL_ERROR "Failed to link client frameworks: ${_link_status}")
endif()

find_library(_sdl3_library NAMES SDL3 PATHS /opt/homebrew/lib /usr/local/lib)
if(_sdl3_library)
    file(COPY "${_sdl3_library}" DESTINATION "${_contents}/Frameworks" FOLLOW_SYMLINK_CHAIN)
endif()

include(BundleUtilities)
set(BU_CHMOD_BUNDLE_ITEMS TRUE)
fixup_bundle("${APP}" "${NATIVE};${_host}" "")

execute_process(
    COMMAND /usr/bin/codesign --verify --strict "${_host}"
    RESULT_VARIABLE _host_verify_status
    OUTPUT_VARIABLE _host_verify_out
    ERROR_VARIABLE _host_verify_error)
if(NOT _host_verify_status EQUAL 0)
    message(FATAL_ERROR "Embedded host signature is invalid: ${_host_verify_error}")
endif()
execute_process(
    COMMAND /usr/bin/codesign -dv --verbose=4 "${_host}"
    RESULT_VARIABLE _host_details_status
    OUTPUT_VARIABLE _host_details_out
    ERROR_VARIABLE _host_details_error)
if(NOT _host_details_status EQUAL 0 OR
   NOT _host_details_error MATCHES "CDHash=${_expected_cdhash}")
    message(FATAL_ERROR "Bundling changed the locally signed host executable")
endif()

file(GLOB_RECURSE _dylibs "${_contents}/Frameworks/*.dylib")
foreach(_dylib IN LISTS _dylibs)
    execute_process(COMMAND /usr/bin/codesign --force --sign - "${_dylib}"
        RESULT_VARIABLE _library_sign_status)
    if(NOT _library_sign_status EQUAL 0)
        message(FATAL_ERROR "Failed to sign bundled library: ${_dylib}")
    endif()
endforeach()
execute_process(COMMAND /usr/bin/codesign --force --sign - "${NATIVE}"
    RESULT_VARIABLE _native_sign_status)
if(NOT _native_sign_status EQUAL 0)
    message(FATAL_ERROR "Failed to sign the native client")
endif()

set(_plist "${_contents}/Info.plist")
execute_process(COMMAND /usr/libexec/PlistBuddy
    -c "Add :NSMicrophoneUsageDescription string SolunaRemote needs microphone access to stream audio."
    "${_plist}" RESULT_VARIABLE _microphone_plist_status)
execute_process(COMMAND /usr/libexec/PlistBuddy
    -c "Add :NSAudioCaptureUsageDescription string SolunaRemote needs system audio access to stream audio."
    "${_plist}" RESULT_VARIABLE _audio_plist_status)
execute_process(COMMAND /usr/libexec/PlistBuddy
    -c "Add :NSScreenCaptureUsageDescription string SolunaRemote needs screen recording access to share this Mac."
    "${_plist}" RESULT_VARIABLE _screen_plist_status)
execute_process(COMMAND /usr/libexec/PlistBuddy
    -c "Add :NSLocalNetworkUsageDescription string SolunaRemote uses the local network for remote desktop connections."
    "${_plist}" RESULT_VARIABLE _network_plist_status)
if(NOT _microphone_plist_status EQUAL 0 OR
   NOT _audio_plist_status EQUAL 0 OR
   NOT _screen_plist_status EQUAL 0 OR
   NOT _network_plist_status EQUAL 0)
    message(FATAL_ERROR "Failed to add macOS privacy descriptions")
endif()

execute_process(COMMAND /usr/libexec/PlistBuddy
    -c "Add :NSBonjourServices array"
    "${_plist}" RESULT_VARIABLE _bonjour_array_status)
execute_process(COMMAND /usr/libexec/PlistBuddy
    -c "Add :NSBonjourServices:0 string _nvstream._tcp"
    "${_plist}" RESULT_VARIABLE _bonjour_service_status)
if(NOT _bonjour_array_status EQUAL 0 OR NOT _bonjour_service_status EQUAL 0)
    message(FATAL_ERROR "Failed to add the Bonjour service declaration")
endif()

execute_process(COMMAND /usr/bin/codesign --force --sign - "${APP}"
    RESULT_VARIABLE _app_sign_status)
if(NOT _app_sign_status EQUAL 0)
    message(FATAL_ERROR "Failed to sign the SolunaRemote application")
endif()
execute_process(COMMAND /usr/bin/codesign --verify --deep --strict "${APP}"
    RESULT_VARIABLE _app_verify_status)
if(NOT _app_verify_status EQUAL 0)
    message(FATAL_ERROR "Failed to verify the SolunaRemote application")
endif()

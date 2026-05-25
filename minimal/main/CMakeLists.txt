if(CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE)
    set(mitr_gateway_client_src "gateway_client_server_wake.c")
else()
    set(mitr_gateway_client_src "gateway_client.c")
endif()

set(mitr_device_srcs
    "main.c"
    "board.c"
    "media.c"
    "preconnect_audio_src.c"
    "device_api.c"
    "device_storage.c"
    "boot_feedback.c"
    "network.c"
    "provisioning.c"
    "ota_manager.c"
    "atomic_compat.c"
    "sounds.c"
    ${mitr_gateway_client_src}
)

set(mitr_device_priv_requires
    esp_http_client
    esp_https_ota
    esp_event
    esp_netif
    esp_wifi
    app_update
    esp_websocket_client
    protocomm
    wifi_provisioning
    json
    nvs_flash
    espressif__esp_audio_codec
    espressif__esp_capture
    tempotian__av_render
    tempotian__codec_board
    tempotian__media_lib_sal
)

if(NOT CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE)
    list(APPEND mitr_device_srcs "wake_word.c")
    list(APPEND mitr_device_priv_requires espressif__esp-sr)
endif()

idf_component_register(
    SRCS
        ${mitr_device_srcs}
    INCLUDE_DIRS
        "."
    EMBED_FILES
        "assets/boot_ready.raw"
    PRIV_REQUIRES
        ${mitr_device_priv_requires}
    WHOLE_ARCHIVE
)

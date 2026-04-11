cmake_minimum_required(VERSION 3.16)

set(LIB "tensorflow/lite/experimental/microfrontend/lib")

idf_component_register(
    SRCS
        "${LIB}/frontend.c"
        "${LIB}/frontend_util.c"
        "${LIB}/filterbank.c"
        "${LIB}/filterbank_util.c"
        "${LIB}/window.c"
        "${LIB}/window_util.c"
        "${LIB}/noise_reduction.c"
        "${LIB}/noise_reduction_util.c"
        "${LIB}/pcan_gain_control.c"
        "${LIB}/pcan_gain_control_util.c"
        "${LIB}/log_scale.c"
        "${LIB}/log_scale_util.c"
        "${LIB}/log_lut.c"
        "${LIB}/fft.cc"
        "${LIB}/fft_util.cc"
        "${LIB}/kiss_fft_int16.cc"
    INCLUDE_DIRS
        "."
    PRIV_INCLUDE_DIRS
        "${CMAKE_CURRENT_LIST_DIR}/../../managed_components/espressif__esp-tflite-micro/third_party/kissfft"
    REQUIRES
        espressif__esp-tflite-micro
)

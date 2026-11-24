# SonicMesh firmware library, built as a Zephyr module. Apps in apps/ pull it in through ZEPHYR_EXTRA_MODULES.

if(CONFIG_SONICMESH)
  zephyr_include_directories(include)

  zephyr_library_named(sonicmesh)
  zephyr_library_sources(
    lib/wire.c
    lib/msg.c
    lib/timesync.c
    lib/status_led.c
    lib/diag.c
    lib/param.c
    lib/shell_cmds.c
    lib/watchdog.c
  )
  # The 1200 baud touch into the UF2 bootloader; an ESP32 is reset into its ROM loader by esptool.
  zephyr_library_sources_ifdef(CONFIG_SOC_FAMILY_NORDIC_NRF lib/bootloader.c)
  zephyr_library_sources_ifdef(CONFIG_SM_ROLE_NODE
    lib/audio.c
    lib/battery.c
    lib/capture.c
    lib/detector.c
    lib/health.c
    lib/radio_node.c
  )
  zephyr_library_sources_ifdef(CONFIG_SM_ROLE_GATEWAY
    lib/radio_gateway.c
  )

  # Detectors. Each one is self-contained and registers itself with SM_DETECTOR_DEFINE.
  zephyr_library_sources_ifdef(CONFIG_SM_DETECTOR_DRONE_COMB
    detectors/drone_comb/comb.c
    detectors/drone_comb/drone_comb.c
  )
  zephyr_library_sources_ifdef(CONFIG_SM_DETECTOR_GUNSHOT
    detectors/gunshot_impulse/impulse.c
    detectors/gunshot_impulse/gunshot.c
  )
  zephyr_library_sources_ifdef(CONFIG_SM_DETECTOR_DEPLOY_TONES
    detectors/deploy_tones/tones.c
    detectors/deploy_tones/deploy_tones.c
  )

  # The build time `sm info` reports, rewritten on every build.
  set(SM_BUILD_TIME_C ${CMAKE_CURRENT_BINARY_DIR}/sm_build_time.c)
  add_custom_target(sm_build_time ALL
    COMMAND ${CMAKE_COMMAND} -DOUT=${SM_BUILD_TIME_C} -P ${CMAKE_CURRENT_LIST_DIR}/lib/build_time.cmake
    BYPRODUCTS ${SM_BUILD_TIME_C})
  zephyr_library_sources(${SM_BUILD_TIME_C})
  add_dependencies(sonicmesh sm_build_time)

  zephyr_linker_sources(SECTIONS lib/sm_iterables.ld)
  zephyr_iterable_section(NAME sm_detector KVMA RAM_REGION GROUP RODATA_REGION)
  zephyr_iterable_section(NAME sm_param KVMA RAM_REGION GROUP RODATA_REGION)
  zephyr_iterable_section(NAME sm_trace KVMA RAM_REGION GROUP RODATA_REGION)
endif()

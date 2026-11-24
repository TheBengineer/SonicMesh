/*
 * Battery voltage on the XIAO nRF52840: VBAT -> 1 M -> P0.31 (AIN7) -> 510 k -> P0.14.
 * P0.14 is the divider's ground switch. It is held low for good: driving it high with a battery
 * connected would put P0.31 above its rating (Seeed's warning). The divider then draws about 3 uA.
 * On USB power with no battery the reading is the charger's output, not a battery level.
 */
#include <zephyr/device.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>

#include <sonicmesh/battery.h>

#define DIV_FULL_OHMS 1510000
#define DIV_OUT_OHMS 510000

static const struct adc_dt_spec ain = ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);
static const struct device *const gpio0 = DEVICE_DT_GET(DT_NODELABEL(gpio0));
static bool ready;

int sm_battery_init(void)
{
	if (!device_is_ready(gpio0) || !adc_is_ready_dt(&ain)) {
		return -ENODEV;
	}
	gpio_pin_configure(gpio0, 14, GPIO_OUTPUT_LOW);
	int err = adc_channel_setup_dt(&ain);

	ready = (err == 0);
	return err;
}

int sm_battery_mv(void)
{
	int16_t raw;
	struct adc_sequence seq = {
		.buffer = &raw,
		.buffer_size = sizeof(raw),
	};

	if (!ready || adc_sequence_init_dt(&ain, &seq) || adc_read_dt(&ain, &seq)) {
		return 0;
	}
	int32_t mv = raw;

	if (adc_raw_to_millivolts_dt(&ain, &mv)) {
		return 0;
	}
	return (int)((int64_t)mv * DIV_FULL_OHMS / DIV_OUT_OHMS);
}

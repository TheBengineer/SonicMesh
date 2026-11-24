#include <stdbool.h>

#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>

#include <sonicmesh/status_led.h>

/* A board with one LED (the XIAO ESP32-S3) shows every colour on led0. */
#define LED_SPEC(alias) \
	GPIO_DT_SPEC_GET(COND_CODE_1(DT_HAS_ALIAS(alias), (DT_ALIAS(alias)), (DT_ALIAS(led0))), gpios)

static const struct gpio_dt_spec leds[] = {
	LED_SPEC(led0), /* red */
	LED_SPEC(led1), /* green */
	LED_SPEC(led2), /* blue */
};

static bool held[ARRAY_SIZE(leds)];
static struct k_work_delayable off_work[ARRAY_SIZE(leds)];

static void led_off(struct k_work *work)
{
	struct k_work_delayable *dw = k_work_delayable_from_work(work);
	size_t i = dw - off_work;

	gpio_pin_set_dt(&leds[i], held[i]);
}

int sm_led_init(void)
{
	for (size_t i = 0; i < ARRAY_SIZE(leds); i++) {
		if (!gpio_is_ready_dt(&leds[i])) {
			return -ENODEV;
		}
		gpio_pin_configure_dt(&leds[i], GPIO_OUTPUT_INACTIVE);
		k_work_init_delayable(&off_work[i], led_off);
	}
	return 0;
}

void sm_led_flash(enum sm_led led, uint32_t ms)
{
	gpio_pin_set_dt(&leds[led], 1);
	k_work_reschedule(&off_work[led], K_MSEC(ms));
}

void sm_led_set(enum sm_led led, bool on)
{
	held[led] = on;
	if (!k_work_delayable_is_pending(&off_work[led])) {
		gpio_pin_set_dt(&leds[led], on);
	}
}

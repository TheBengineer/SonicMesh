/*
 * Reflashing without the reset button. A host that opens the USB serial port at 1200 baud (the
 * Arduino "touch") makes the board restart into its UF2 bootloader, which tools/flash.sh writes the
 * new image to.
 */
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/reboot.h>

#include <hal/nrf_power.h>

/* Adafruit nRF52 bootloader: GPREGRET value that starts it in UF2 mode, as a USB drive. */
#define DFU_MAGIC_UF2_RESET 0x57

static const struct device *const console = DEVICE_DT_GET(DT_CHOSEN(zephyr_console));

static void touch_check(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(touch_work, touch_check);

static void touch_check(struct k_work *work)
{
	uint32_t baud = 0;

	if (uart_line_ctrl_get(console, UART_LINE_CTRL_BAUD_RATE, &baud) == 0 && baud == 1200) {
		printk("1200 baud touch: restarting into the bootloader\n");
		k_msleep(50);
		NRF_POWER->GPREGRET = DFU_MAGIC_UF2_RESET;
		sys_reboot(SYS_REBOOT_WARM);
	}
	k_work_reschedule(k_work_delayable_from_work(work), K_MSEC(200));
}

static int touch_init(void)
{
	if (device_is_ready(console)) {
		k_work_reschedule(&touch_work, K_MSEC(200));
	}
	return 0;
}

SYS_INIT(touch_init, APPLICATION, 99);

/* SonicMesh gateway: hears every node on Coded PHY, prints records as JSON lines, sends the sync beacon. */
#include <zephyr/kernel.h>

#include <sonicmesh/diag.h>
#include <sonicmesh/param.h>
#include <sonicmesh/radio.h>
#include <sonicmesh/status_led.h>

int main(void)
{
	sm_led_init();
	sm_led_flash(SM_LED_BLUE, 500);
	k_msleep(1500);
	printk("SonicMesh gateway\n");
	sm_diag_print();
	sm_params_init(); /* before anything reads a parameter */
	printk("{\"k\":\"boot\",\"cause\":%u,\"crashes\":%u}\n", sm_diag_reset_cause(), sm_diag_crashes());

	if (sm_radio_start() != 0) {
		sm_led_set(SM_LED_RED, true);
	}
	return 0;
}

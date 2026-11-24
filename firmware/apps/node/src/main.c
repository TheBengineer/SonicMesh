/* SonicMesh sensor node: mic capture, every enabled detector, and the Coded PHY broadcast. */
#include <zephyr/kernel.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/diag.h>
#include <sonicmesh/param.h>
#include <sonicmesh/msg.h>
#include <sonicmesh/radio.h>
#include <sonicmesh/status_led.h>

int main(void)
{
	sm_led_init();
	sm_led_flash(SM_LED_GREEN, 500);
	k_msleep(1500); /* give a serial monitor time to attach */
	printk("SonicMesh node %04x\n", sm_node_id());
	sm_diag_print();
	sm_params_init(); /* before anything reads a parameter */

	if (sm_radio_start() != 0) {
		sm_led_set(SM_LED_RED, true);
		return 0;
	}
	if (sm_audio_start() != 0) {
		sm_led_set(SM_LED_RED, true);
		return 0;
	}
	sm_health_start();
	return 0;
}

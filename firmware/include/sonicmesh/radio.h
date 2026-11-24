/*
 * BLE Coded PHY (S8, long range) broadcast. Nodes send frames of records as non-connectable extended
 * advertisements and listen for the gateway's sync beacon. The gateway listens for every node, prints
 * what it hears on USB serial and sends the sync beacon. No connections, no pairing: any number of
 * nodes, and any number of record types, share the same broadcast.
 */
#ifndef SONICMESH_RADIO_H
#define SONICMESH_RADIO_H

int sm_radio_start(void);

/* Node health: sends SM_REC_HEALTH and prints a status block every CONFIG_SM_HEALTH_PERIOD_S. */
int sm_health_start(void);

#endif

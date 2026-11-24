/*
 * Outgoing records. Any code can queue a record; the radio packs pending records into frames and sends
 * each one SM_RECORD_REPEATS times.
 */
#ifndef SONICMESH_MSG_H
#define SONICMESH_MSG_H

#include <stddef.h>
#include <stdint.h>

/* Queues a record. Safe from any thread. Returns 0, or -ENOMEM when the pool is full (counted). */
int sm_msg_send(uint8_t type, const void *payload, uint8_t len);

/*
 * Queues a timed record: writes the 5-byte timed header for local time t_local_us, then body.
 * The time is converted to network time if the node is synced.
 */
int sm_msg_send_timed(uint8_t type, int64_t t_local_us, const void *body, uint8_t body_len);

/*
 * Builds the next frame from pending records, oldest first, into buf. Each included record uses up
 * one repeat and is freed after its last. Returns the frame length, or 0 if nothing is pending.
 */
size_t sm_msg_fill_frame(uint8_t *buf, size_t cap, uint16_t node, uint8_t flags);

/* Records waiting, and records dropped because the pool was full. */
unsigned int sm_msg_pending(void);
unsigned int sm_msg_dropped(void);

/* This node's id, from the chip's device id. */
uint16_t sm_node_id(void);

#endif

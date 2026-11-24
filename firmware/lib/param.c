#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>

#include <sonicmesh/param.h>

LOG_MODULE_REGISTER(sm_param, CONFIG_SONICMESH_LOG_LEVEL);

/* Saved values live under "sm/<name>" as a 4-byte float. */
#define SETTINGS_ROOT "sm"

__weak void sm_detector_param_changed(const char *name)
{
	ARG_UNUSED(name);
}

const struct sm_param *sm_param_find(const char *name)
{
	STRUCT_SECTION_FOREACH(sm_param, p) {
		if (strcmp(p->name, name) == 0) {
			return p;
		}
	}
	return NULL;
}

float sm_param_get(const struct sm_param *p)
{
	switch (p->type) {
	case SM_PARAM_TYPE_int:
		return (float)*(int32_t *)p->value;
	case SM_PARAM_TYPE_bool:
		return *(bool *)p->value ? 1.0f : 0.0f;
	default:
		return *(float *)p->value;
	}
}

/* Writes without range checks or change hooks. */
static void store(const struct sm_param *p, float v)
{
	switch (p->type) {
	case SM_PARAM_TYPE_int:
		*(int32_t *)p->value = (int32_t)lrintf(v);
		break;
	case SM_PARAM_TYPE_bool:
		*(bool *)p->value = v != 0.0f;
		break;
	default:
		*(float *)p->value = v;
		break;
	}
}

static void notify(const struct sm_param *p)
{
	if (p->changed) {
		p->changed(p);
	}
	sm_detector_param_changed(p->name);
}

static int check(const struct sm_param *p, float *v)
{
	if (!isfinite(*v)) {
		return -EINVAL;
	}
	if (p->type != SM_PARAM_TYPE_float) {
		*v = rintf(*v);
	}
	return *v < p->min || *v > p->max ? -ERANGE : 0;
}

static bool ready; /* sm_params_init has loaded the saved values */

int sm_param_set(const struct sm_param *p, float v)
{
	int err = check(p, &v);

	if (err) {
		return err;
	}
	/* The same value again changes nothing: no hook, so a detector is not restarted for it. */
	if (sm_param_get(p) == v) {
		return 0;
	}
	store(p, v);
	notify(p);
	return 0;
}

int sm_param_parse(const struct sm_param *p, const char *text, float *v)
{
	char *end;

	if (p->type == SM_PARAM_TYPE_bool) {
		if (!strcmp(text, "true") || !strcmp(text, "on")) {
			*v = 1;
			return 0;
		}
		if (!strcmp(text, "false") || !strcmp(text, "off")) {
			*v = 0;
			return 0;
		}
	}
	*v = strtof(text, &end);
	if (end == text || *end != '\0') {
		return -EINVAL;
	}
	if (p->type != SM_PARAM_TYPE_float && *v != rintf(*v)) {
		return -EINVAL;
	}
	return check(p, v);
}

int sm_param_set_str(const struct sm_param *p, const char *text)
{
	float v;
	int err = sm_param_parse(p, text, &v);

	return err ? err : sm_param_set(p, v);
}

void sm_params_reset(const struct sm_param *only)
{
	STRUCT_SECTION_FOREACH(sm_param, p) {
		if (!only || only == p) {
			store(p, p->def);
			notify(p);
		}
	}
}

int sm_params_save(void)
{
	char key[64];
	int err = 0;

	STRUCT_SECTION_FOREACH(sm_param, p) {
		float v = sm_param_get(p);
		int e;

		snprintk(key, sizeof(key), SETTINGS_ROOT "/%s", p->name);
		if (v == p->def) {
			e = settings_delete(key);
		} else {
			e = settings_save_one(key, &v, sizeof(v));
		}
		if (e && !err) {
			err = e;
		}
	}
	return err;
}

static int on_load(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	const struct sm_param *p = sm_param_find(name);
	float v;

	if (!p) {
		/* A parameter a newer or older build had. Left in flash; ignored. */
		LOG_WRN("saved setting %s is not a parameter in this build, ignored", name);
		return 0;
	}
	if (len != sizeof(v) || read_cb(cb_arg, &v, sizeof(v)) != sizeof(v)) {
		LOG_WRN("saved setting %s is unreadable, ignored", name);
		return 0;
	}
	if (!isfinite(v) || v < p->min || v > p->max) {
		LOG_WRN("saved %s = %g is outside %g..%g in this build, using the default", name, (double)v,
			(double)p->min, (double)p->max);
		return 0;
	}
	store(p, v);
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(sm_params, SETTINGS_ROOT, NULL, on_load, NULL, NULL);

int sm_params_init(void)
{
	int n = 0;

	STRUCT_SECTION_FOREACH(sm_param, p) {
		store(p, p->def);
		n++;
	}
	int err = settings_subsys_init();

	if (err == 0) {
		err = settings_load_subtree(SETTINGS_ROOT);
	}
	if (err) {
		LOG_ERR("saved parameters not loaded (%d); running on defaults", err);
	}
	/* Hooks run once for loaded values, e.g. so derived constants are computed. */
	STRUCT_SECTION_FOREACH(sm_param, p) {
		if (p->changed) {
			p->changed(p);
		}
	}
	LOG_INF("%d parameters", n);
	ready = true;
	return err;
}

bool sm_params_ready(void)
{
	return ready;
}

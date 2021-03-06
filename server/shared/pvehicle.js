/**
 * @author jareiko / http://www.jareiko.net/
 */

var MODULE = 'pvehicle';


(function(exports) {
  var _ = this._ || require('underscore');
  var LFIB4 = this.LFIB4 || require('./LFIB4');
  var THREE = this.THREE || require('../THREE');
  var psim = this.psim || require('./psim');
  var util = this.util || require('./util');

  var Vec2 = THREE.Vector2;
  var Vec3 = THREE.Vector3;
  var Quat = THREE.Quaternion;

  var Vec3FromArray = util.Vec3FromArray;
  var TWOPI = util.TWOPI;
  var PULLTOWARD = util.PULLTOWARD;
  var MOVETOWARD = util.MOVETOWARD;
  var CLAMP = util.CLAMP;
  var INTERP = util.INTERP;

  // TODO: Transfer these to config.
  var CLIP_CONSTANT = 200000;
  var CLIP_DAMPING = 8000;
  var SUSP_CONSTANT = 70000;
  var SUSP_DAMPING = 50;
  var SUSP_MAX = 0.13;
  var WHEEL_MASS = 15;
  var BUMPS_PER_RADIAN = 0.6;
  var THROTTLE_RESPONSE = 8;
  var BRAKE_RESPONSE = 5;
  var HANDBRAKE_RESPONSE = 20;
  var TURN_RESPONSE = 5;
  var ENGINE_BRAKE_REGION = 0.5;
  var ENGINE_BRAKE_TORQUE = 0.1;
  var REDLINE_RECOVER_FRACTION = 0.98;
  var LSD_VISCOUS_CONSTANT = 400;
  var MIN_TIME_BETWEEN_SHIFTS = 0.2;
  var FRICTION_DYNAMIC_CHASSIS = 0.9 * 0.9;
  var FRICTION_STATIC_CHASSIS = 1.2 * 0.9;
  var FRICTION_DYNAMIC_WHEEL = 0.9 * 1.2;
  var FRICTION_STATIC_WHEEL = 1.2 * 1.2;

  var RPM_TO_RPS = function (r) { return r * TWOPI / 60; };

  function BiasedPull(val, target, deltaUp, deltaDown) {
    if (target >= val) {
      return PULLTOWARD(val, target, deltaUp);
    } else {
      return PULLTOWARD(val, target, deltaDown);
    }
  };

  function getEnginePower(angVel, powerband) {
    if (angVel <= 0) {
      return 0;
    }
    if (angVel <= powerband[0].radps) {
      return powerband[0].power * angVel / powerband[0].radps;
    }
    var p;
    for (p = 1; p < powerband.length; ++p) {
      if (angVel <= powerband[p].radps) {
        // TODO: Precompute radps divisors.
        return INTERP(powerband[p - 1].power,
                      powerband[p].power,
                      (angVel - powerband[p - 1].radps) /
                          (powerband[p].radps - powerband[p - 1].radps));
      }
    }
    return powerband[p - 1].power;
  }

  exports.AutomaticController = function(vehicle) {
    this.vehicle = vehicle;
    this.shiftTimer = 0;
    this.input = {
      forward: 0,
      back: 0,
      left: 0,
      right: 0,
      handbrake: 0
    };
    this.output = {
      throttle: 0,
      clutch: 1,  // 0 = disengaged, 1 = fully engaged
      gear: 1,  // -1 = reverse, 0 = neutral, 1 = first gear, etc.
      brake: 0,
      handbrake: 0,
      desiredTurnPos: 0
    };
  };

  exports.AutomaticController.prototype.tick = function(delta) {
    var input = this.input;
    var output = this.output;
    var vehicle = this.vehicle;
    var powerband = vehicle.cfg.engine.powerband;

    var GetTorque = function(testGear) {
      var testAngVel = vehicle.engineAngVel *
          vehicle.gearRatios[testGear] / vehicle.gearRatios[output.gear];
      var testPower = getEnginePower(testAngVel, powerband);
      return testPower * vehicle.gearRatios[testGear] / testAngVel;
    };

    var accel = input.forward;
    var brake = input.back;

    // We estimate what the engine speed would be at a different gear, and see
    // if it would provide more torque.
    var engineAngVel = vehicle.engineAngVel;
    var currentPower = getEnginePower(vehicle.engineAngVel, powerband);
    var currentTorque = currentPower * vehicle.gearRatios[output.gear] / vehicle.engineAngVel;
    if (this.shiftTimer <= 0) {
      if (output.clutch && output.gear >= 1) {
        var nextGearRel = 0;
        if (output.gear > 1 &&
            GetTorque(output.gear - 1) > currentTorque) {
          output.gear -= 1;
          this.shiftTimer = MIN_TIME_BETWEEN_SHIFTS;
          //output.clutch = 0;
        } else if (output.gear < vehicle.gearRatios.length - 1 &&
                   GetTorque(output.gear + 1) > currentTorque) {
          output.gear += 1;
          this.shiftTimer = MIN_TIME_BETWEEN_SHIFTS;
          //output.clutch = 0;
        } else if (brake && vehicle.differentialAngVel < 1) {
          output.gear = -1;
          this.shiftTimer = MIN_TIME_BETWEEN_SHIFTS;
        }
      } else if (output.gear == -1) {
        if (accel) {
          output.gear = 1;
          this.shiftTimer = MIN_TIME_BETWEEN_SHIFTS;          
        } else {
          accel = brake;
          brake = 0;
        }
      }
    } else {
      this.shiftTimer -= delta;
      //output.clutch = 0;
    }

    output.throttle = PULLTOWARD(output.throttle, accel,
        delta * THROTTLE_RESPONSE);
    output.brake = PULLTOWARD(output.brake, brake,
        delta * BRAKE_RESPONSE);
    output.handbrake = PULLTOWARD(output.handbrake, input.handbrake,
        delta * HANDBRAKE_RESPONSE);
    output.desiredTurnPos = PULLTOWARD(output.desiredTurnPos, input.left - input.right,
        delta * TURN_RESPONSE);

    // Disengage clutch when using handbrake.
    output.clutch = 1;
    output.clutch *= (output.handbrake < 0.5) ? 1 : 0;
  };

  exports.Vehicle = function(sim, config) {
    this.sim = sim;
    // It's important that we add ourselves before our rigid bodies, so that we
    // get ticked first each frame.
    sim.addObject(this);

    this.cfg = config;
    
    this.body = new psim.RigidBody(sim);
    this.body.setMassCuboid(
        config.mass,
        Vec3FromArray(config.dimensions).multiplyScalar(0.5));

    this.wheelTurnPos = -1;
    this.wheelTurnVel = 0;
    this.totalDrive = 0;

    for (var i = 0; i < config.clips.length; ++i) {
      var cfg = config.clips[i];
      cfg.pos[0] -= config.center[0];
      cfg.pos[1] -= config.center[1];
      cfg.pos[2] -= config.center[2];
    }

    this.wheels = [];
    for (var w = 0; w < config.wheels.length; ++w) {
      var wheel = this.wheels[w] = {};
      wheel.cfg = config.wheels[w];
      wheel.cfg.pos[0] -= config.center[0];
      wheel.cfg.pos[1] -= config.center[1];
      wheel.cfg.pos[2] -= config.center[2];
      wheel.ridePos = 0;
      wheel.rideVel = 0;
      wheel.spinPos = 0;
      wheel.spinVel = 0;
      wheel.bumpLast = 0;
      wheel.bumpNext = 0;
      wheel.bumpTravel = 0;
      wheel.frictionForce = new Vec2();
      this.totalDrive += wheel.cfg.drive || 0;
    }

    this.controller = new exports.AutomaticController(this);
    
    for (var p = 0; p < config.engine.powerband.length; ++p) {
      config.engine.powerband[p].radps =
          config.engine.powerband[p].rpm * TWOPI / 60;
    }
    this.engineAngVel = 0;  // radians per second
    this.engineAngVelSmoothed = 0;  // for display purposes
    this.engineIdle = config.engine.powerband[0].radps;
    this.engineRedline = config.engine.redline * TWOPI / 60;
    this.engineRecover = this.engineRedline * REDLINE_RECOVER_FRACTION;
    this.engineOverspeed = false;
    this.enginePowerscale = config.engine.powerscale * 1000;  // kW to W

    var finalRatio = config.transmission['final'];
    this.gearRatios = [];
    this.gearRatios[-1] = -config.transmission.reverse * finalRatio;
    this.gearRatios[0] = 0;
    for (var g = 0; g < config.transmission.forward.length; ++g) {
      this.gearRatios[g + 1] = config.transmission.forward[g] * finalRatio;
    }
    
    this.recoverTimer = 0;
    this.crashLevel = 0;
    this.crashLevelPrev = 0;
    this.skidLevel = 0;
    this.disabled = false;
    this.random = LFIB4.LFIB4(5);
  };

  exports.Vehicle.prototype.recordState = function() {
    // TODO: Implement.
  };

  exports.Vehicle.prototype.getState = function() {
    // TODO: Implement.
    return {};
  };

  exports.Vehicle.prototype.recover = function(delta) {
    var state = this.recoverState;
    var body = this.body;
    if (!state) {
      // Work out which way vehicle is facing.
      var angleY = Math.atan2(body.oriMat.elements[8], body.oriMat.elements[0]);
      var newOri = new Quat().setFromAxisAngle(new Vec3(0,1,0), Math.PI -angleY);

      // Make sure we take the shortest path.
      var cosHalfTheta = newOri.x * body.ori.x + newOri.y * body.ori.y +
                         newOri.z * body.ori.z + newOri.w * body.ori.w;
      if (cosHalfTheta < 0) {
        newOri.x *= -1; newOri.y *= -1;
        newOri.z *= -1; newOri.w *= -1;
      }

      state = this.recoverState = {
        pos: body.pos.clone().addSelf(
            Vec3FromArray(this.cfg.recover.posOffset)),
        ori: newOri
      };
      this.disabled = true;
    }
    var pull = delta * 4;
    body.pos.x = PULLTOWARD(body.pos.x, state.pos.x, pull);
    body.pos.y = PULLTOWARD(body.pos.y, state.pos.y, pull);
    body.pos.z = PULLTOWARD(body.pos.z, state.pos.z, pull);
    body.ori.x = PULLTOWARD(body.ori.x, state.ori.x, pull);
    body.ori.y = PULLTOWARD(body.ori.y, state.ori.y, pull);
    body.ori.z = PULLTOWARD(body.ori.z, state.ori.z, pull);
    body.ori.w = PULLTOWARD(body.ori.w, state.ori.w, pull);
    body.linVel.set(0, 0, 0);
    body.angVel.set(0, 0, 0);

    if (this.recoverTimer >= this.cfg.recover.releaseTime) {
      this.recoverTimer = 0;
      this.recoverState = null;
      this.disabled = false;
    }
  };

  /*
  Powertrain layout:
  Engine - Clutch - Gearbox - Differential - Wheels
  */

  exports.Vehicle.prototype.tick = function(delta) {
    var c;
    this.controller.tick(delta);
    var powerband = this.cfg.engine.powerband;
    var controls = this.controller.output;
    var throttle = controls.throttle;

    if (this.disabled) {
      // Car is disabled, eg. before start or for recovery.
      controls.clutch = 0;
      controls.brake = 1;
      controls.desiredTurnPos = 0;
    }

    this.crashLevelPrev = PULLTOWARD(this.crashLevelPrev, this.crashLevel, delta * 5);
    this.crashLevel = PULLTOWARD(this.crashLevel, 0, delta * 5);
    this.skidLevel = 0;

    if (this.body.oriMat.elements[5] <= 0.1 ||
        this.recoverTimer >= this.cfg.recover.triggerTime) {
      this.recoverTimer += delta;
      
      if (this.recoverTimer >= this.cfg.recover.triggerTime) {
        this.recover(delta);
      }
    } else {
      this.recoverTimer = 0;
    }

    // Compute some data about vehicle's current state.
    var differentialAngVel = 0;
    var wheelLateralForce = 0;
    for (c = 0; c < this.wheels.length; ++c) {
      var wheel = this.wheels[c];
      differentialAngVel += wheel.spinVel * (wheel.cfg.drive || 0);
      wheelLateralForce += wheel.frictionForce.x;
    }
    differentialAngVel /= this.totalDrive;
    this.differentialAngVel = differentialAngVel;

    // If we're in gear, lock engine speed to differential.
    var gearRatio = this.gearRatios[controls.gear];
    if (gearRatio != 0 && controls.clutch) {
      this.engineAngVel = differentialAngVel * gearRatio;
    }
    if (this.engineAngVel < this.engineIdle) {
      this.engineAngVel = this.engineIdle;
    }

    // Check for over-revving.
    if (this.engineOverspeed) {
      this.engineOverspeed = (this.engineAngVel > this.engineRecover);
      if (this.engineOverspeed) {
        throttle = 0;
        // Make throttle come up smoothly from zero again.
        controls.throttle = 0;  // TODO: Find a better way to do this?
      }
    } else {
      if (this.engineAngVel > this.engineRedline) {
        throttle = 0;
        this.engineOverspeed = true;
      }
    }

    // Extend throttle range to [-1, 1] including engine braking.
    var extendedThrottle = throttle - ENGINE_BRAKE_REGION;
    if (extendedThrottle >= 0) {
      extendedThrottle /= (1 - ENGINE_BRAKE_REGION);
    } else {
      extendedThrottle /= ENGINE_BRAKE_REGION;
    }

    var engineTorque;
    if (extendedThrottle >= 0) {
      // Positive engine power.
      var enginePower = extendedThrottle * this.enginePowerscale *
          getEnginePower(this.engineAngVel, powerband);
      engineTorque = enginePower / this.engineAngVel;
    } else {
      // Engine braking does not depend on powerband.
      // TODO: Add engine braking range and power to config.
      engineTorque = ENGINE_BRAKE_TORQUE * extendedThrottle * (this.engineAngVel - this.engineIdle);
    }

    var perWheelTorque = 0;
    if (gearRatio != 0 && controls.clutch) {
      var differentialTorque = engineTorque * gearRatio;
      perWheelTorque = differentialTorque / this.totalDrive;
    } else {
      this.engineAngVel += 50000 * engineTorque * delta / this.cfg.engine.flywheel;
      if (this.engineAngVel < this.engineIdle) {
        this.engineAngVel = this.engineIdle;
      }
    }

    for (c = 0; c < this.wheels.length; ++c) {
      var wheel = this.wheels[c];
      var wheelTorque = wheel.frictionForce.y * 0.3;
      // Viscous 2-way LSD.
      if (wheel.cfg.drive) {
        var diffSlip = wheel.spinVel - differentialAngVel;
        var diffTorque = diffSlip * LSD_VISCOUS_CONSTANT;
        wheelTorque += (perWheelTorque - diffTorque) * wheel.cfg.drive;
      }
      // TODO: Convert torque to ang accel with proper units.
      wheel.spinVel += 0.13 * wheelTorque * delta;
      var brake =
          controls.brake * (wheel.cfg.brake || 0) +
          controls.handbrake * (wheel.cfg.handbrake || 0);
      if (brake > 0) {
        wheel.spinVel = MOVETOWARD(wheel.spinVel, 0, brake * delta);
      }
    }

    // TODO: Use real clip geometry instead of just points.
    for (c = 0; c < this.cfg.clips.length; ++c) {
      this.clipPoint(this.cfg.clips[c]);
    }
    //this.clipHull();
    for (c = 0; c < this.cfg.clipEdges.length; ++c) {
      this.clipEdge(this.cfg.clipEdges[c]);
    }
    var wheelTurnVelTarget =
        (controls.desiredTurnPos - this.wheelTurnPos) * 300 + wheelLateralForce * -0.005;
    wheelTurnVelTarget = CLAMP(wheelTurnVelTarget, -8, 8);
    this.wheelTurnVel = PULLTOWARD(this.wheelTurnVel,
                                   wheelTurnVelTarget,
                                   delta * 10);
    this.wheelTurnPos += this.wheelTurnVel * delta;
    this.wheelTurnPos = CLAMP(this.wheelTurnPos, -1, 1);
    for (c = 0; c < this.cfg.wheels.length; ++c) {
      this.tickWheel(this.wheels[c], delta);
    }

    this.engineAngVelSmoothed = PULLTOWARD(
        this.engineAngVelSmoothed, this.engineAngVel, delta * 20);
  };

  var getSurfaceBasis = function(normal, right) {
    // TODO: Return a matrix type.
    var basis = {};
    basis.w = normal;  // Assumed to be normalized.
    basis.v = new Vec3().cross(normal, right);
    basis.v.normalize();
    basis.u = new Vec3().cross(basis.v, normal);
    basis.u.normalize();
    return basis;
  }

  exports.Vehicle.prototype.clipPoint = function(clip) {
    var clipPos = this.body.getLocToWorldPoint(Vec3FromArray(clip.pos));
    var contactVel = this.body.getLinearVelAtPoint(clipPos);
    var contacts = this.sim.collide(clipPos);
    for (var c = 0; c < contacts.length; ++c) {
      this.contactResponse(contacts[c]);
    }
  };

  exports.Vehicle.prototype.clipHull = function() {
    // UNFINISHED
    // TODO: Finish it :)
    var convexHull = [
      new Vec4( 1, 0, 0,  this.cfg.dimensions[0]),
      new Vec4(-1, 0, 0, -this.cfg.dimensions[0]),
      new Vec4( 0, 1, 0,  this.cfg.dimensions[1]),
      new Vec4( 0,-1, 0, -this.cfg.dimensions[1]),
      new Vec4( 0, 0, 1,  this.cfg.dimensions[2]),
      new Vec4( 0, 0,-1, -this.cfg.dimensions[2])
    ];
    convexHull.forEach(function(plane) {
      this.body.oriMat.multiplyVector4(plane);
    });
    var RADIUS = 5;
    var contacts = this.sim.collideConvexHull(convexHull, this.body.pos, RADIUS);
    for (var c = 0; c < contacts.length; ++c) {
      this.contactResponse(contacts[c]);
    }
  };

  exports.Vehicle.prototype.clipEdge = function(edge) {
    var clip1 = this.cfg.clips[edge[0]];
    var clip2 = this.cfg.clips[edge[1]];
    var clipPos1 = this.body.getLocToWorldPoint(Vec3FromArray(clip1.pos));
    var clipPos2 = this.body.getLocToWorldPoint(Vec3FromArray(clip2.pos));
    var contacts = this.sim.collideLineSegment(clipPos1, clipPos2);
    for (var c = 0; c < contacts.length; ++c) {
      this.contactResponse(contacts[c]);
    }
  };

  exports.Vehicle.prototype.contactResponse = function(contact) {
    var surf = getSurfaceBasis(contact.normal, new Vec3(1,0,0));
    var contactVel = this.body.getLinearVelAtPoint(contact.surfacePos);

    // Local velocity in surface space.
    var contactVelSurf = new Vec3(
        contactVel.dot(surf.u),
        contactVel.dot(surf.v),
        contactVel.dot(surf.w));

    // Disabled because it sounds a bit glitchy.
//    this.skidLevel += Math.sqrt(contactVelSurf.x * contactVelSurf.x +
//                                contactVelSurf.y * contactVelSurf.y);

    // Damped spring model for perpendicular contact force.
    var perpForce = contact.depth * CLIP_CONSTANT -
                    contactVelSurf.z * CLIP_DAMPING;
    
    // Make sure the objects are pushing apart.
    if (perpForce > 0) {
      // TODO: Reexamine this friction algorithm.
      var friction = new Vec2(-contactVelSurf.x, -contactVelSurf.y).
          multiplyScalar(10000);

      var maxFriction = perpForce * FRICTION_DYNAMIC_CHASSIS;
      var testFriction = perpForce * FRICTION_STATIC_CHASSIS;
      
      var leng = friction.length();
      
      if (leng > testFriction)
        friction.multiplyScalar(maxFriction / leng);
      
      // Not bothering to clone at this point.
      var force = surf.w.multiplyScalar(perpForce);
      force.addSelf(surf.u.multiplyScalar(friction.x));
      force.addSelf(surf.v.multiplyScalar(friction.y));

      this.body.addForceAtPoint(force, contact.surfacePos);
      
      this.crashLevel = Math.max(this.crashLevel, perpForce);
    }
  };

  exports.Vehicle.prototype.tickWheel = function(wheel, delta) {
    var suspensionForce = wheel.ridePos * SUSP_CONSTANT;
    wheel.frictionForce.set(0, 0);

    // F = m.a, a = F / m
    wheel.rideVel -= suspensionForce / WHEEL_MASS * delta;
    // We apply suspension damping semi-implicitly.
    wheel.rideVel *= 1 / (1 + SUSP_DAMPING * delta);
    wheel.ridePos += wheel.rideVel * delta;

    wheel.spinPos += wheel.spinVel * delta;
    wheel.spinPos -= Math.floor(wheel.spinPos / TWOPI) * TWOPI;

    // Wheel bump makes sims diverge faster, so disabling it.
    /*
    wheel.bumpTravel += Math.abs(wheel.spinVel) * BUMPS_PER_RADIAN * delta;

    if (wheel.bumpTravel >= 1) {
      wheel.bumpLast = wheel.bumpNext;
      wheel.bumpTravel -= Math.floor(wheel.bumpTravel);

      wheel.bumpNext = (this.random() - 0.5) * this.random() * 0.05;
    }
    */

    // TICK STUFF ABOVE HERE

    var clipPos = this.body.getLocToWorldPoint(Vec3FromArray(wheel.cfg.pos));
    
    // TODO: Try moving along radius instead of straight down?
    // TODO: Add virtual terrain bumps.
    clipPos.y += wheel.ridePos - wheel.cfg.radius;
    // Wheel bump makes sims diverge faster, so disabling it.
    //clipPos.y += INTERP(wheel.bumpLast, wheel.bumpNext, wheel.bumpTravel);
    var contactVel = this.body.getLinearVelAtPoint(clipPos);
    var contacts = this.sim.collide(clipPos);
    for (var c = 0; c < contacts.length; ++c) {
      var contact = contacts[c];
      var surf = getSurfaceBasis(contact.normal,
                                 this.getWheelRightVector(wheel));

      // Local velocity in surface space.
      var contactVelSurf = new Vec3(
          contactVel.dot(surf.u),
          contactVel.dot(surf.v),
          contactVel.dot(surf.w));

      contactVelSurf.y += wheel.spinVel * wheel.cfg.radius;

      this.skidLevel += Math.sqrt(contactVelSurf.x * contactVelSurf.x +
                                  contactVelSurf.y * contactVelSurf.y);

      // Damped spring model for perpendicular contact force.
      var perpForce = suspensionForce - contactVelSurf.z * CLIP_DAMPING;
      wheel.ridePos += contact.depth;
      
      if (wheel.ridePos > SUSP_MAX) {
        // Suspension has bottomed out. Switch to hard clipping.
        var overDepth = wheel.ridePos - SUSP_MAX;
        
        wheel.ridePos = SUSP_MAX;
        wheel.rideVel = 0;

        perpForce = contact.depth * CLIP_CONSTANT -
                    contactVelSurf.z * CLIP_DAMPING;
      }
      
      if (wheel.rideVel < -contactVelSurf.z)
        wheel.rideVel = -contactVelSurf.z;

      // Make sure the objects are pushing apart.
      if (perpForce > 0) {
        // TODO: Reexamine this friction algorithm.
        var friction = new Vec2(-contactVelSurf.x, -contactVelSurf.y).
            multiplyScalar(3000);

        var maxFriction = perpForce * FRICTION_DYNAMIC_WHEEL;
        var testFriction = perpForce * FRICTION_STATIC_WHEEL;

        var leng = friction.length();

        if (leng > testFriction)
          friction.multiplyScalar(maxFriction / leng);

        wheel.frictionForce.addSelf(friction);
        
        // surf is corrupted by these calculations.
        var force = surf.w.multiplyScalar(perpForce);
        force.addSelf(surf.u.multiplyScalar(friction.x));
        force.addSelf(surf.v.multiplyScalar(friction.y));

        this.body.addForceAtPoint(force, clipPos);
      }
    }
  };
  
  exports.Vehicle.prototype.getWheelTurnPos = function(wheel) {
    // TODO: Turning-circle alignment.
    return (wheel.cfg.turn || 0) * this.wheelTurnPos;
  }

  exports.Vehicle.prototype.getWheelRightVector = function(wheel) {
    var turnPos = this.getWheelTurnPos(wheel);
    var cosTurn = Math.cos(turnPos);
    var sinTurn = Math.sin(turnPos);
    var left = this.body.oriMat.getColumnX().clone();
    var fwd = this.body.oriMat.getColumnZ();
    var wheelRight = new Vec3(
        left.x * cosTurn - fwd.x * sinTurn,
        left.y * cosTurn - fwd.y * sinTurn,
        left.z * cosTurn - fwd.z * sinTurn
    );
    return wheelRight;
  };

  exports.Vehicle.prototype.getCrashNoiseLevel = function() {
    if (this.crashLevel > this.crashLevelPrev) {
      this.crashLevelPrev = this.crashLevel * 2;
      return this.crashLevel;
    } else {
      return 0;
    }
  };
  
  exports.Vehicle.prototype.grabSnapshot = function() {
    return filterObject(this, keys);
  };
})(typeof exports === 'undefined' ? this[MODULE] = {} : exports);

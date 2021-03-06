// Copyright (c) 2012 jareiko. All rights reserved.

var objects = require('../objects');
var mongoose = require('mongoose');
var async = require('async');
var _ = require('underscore');
var recorder = require('../shared/recorder');

var User = mongoose.model('User');
var Verify = mongoose.model('Verify');
var Car = mongoose.model('Car');
var Track = mongoose.model('Track');
var Run = mongoose.model('Run');
var MetricsRecord = mongoose.model('MetricsRecord');

exports.defaultParams = function(req, res, next) {
  req.jadeParams = {
      title: null
    , user: req.user && req.user.user || null
    , userPassport: req.user
      // For form field entries.
    , fieldtype: 'text'
    , value: ''
    , focus: 0
    , editing: false
  };
  next();
};

exports.index = function(req, res) {
  res.render('index', req.jadeParams);
};

exports.about = function(req, res) {
  req.jadeParams.title = 'About';
  res.render('about', req.jadeParams);
};

exports.login = function(req, res) {
  req.jadeParams.title = 'Log In';
  req.jadeParams.validate = {};
  res.render('login', req.jadeParams);
};

/*
exports.verify = function(res, req) {
  require('passport').authenticate('local')(req, res, function() {
    res.redirect('/user/' + req.user.pub_id + '/edit');
  });
};
*/

exports.userconfirm = function(req, res) {
  req.jadeParams.title = 'Confirm';
  req.jadeParams.validate = {};
  res.render('confirmcreate', req.jadeParams);
};

exports.user = function(req, res) {
  function next(error, runs) {
    if (error) {
      console.log('Error fetching runs:');
      console.log(error);
      res.send(500);
    } else {
      req.jadeParams.title = req.urlUser.name;
      req.jadeParams.urlUser = req.urlUser;
      req.jadeParams.editing = req.editing || false;
      req.jadeParams.validate = objects.validation.User.profileValidator;
      req.jadeParams.runs = runs;
      res.render('user', req.jadeParams);
    }
  }
  if (req.editing) next()
  else Run
    .find({ user: req.urlUser.id })
    .limit(500)
    .desc('_id')
    .populate('track', ['pub_id', 'name'])
    .populate('car', ['pub_id', 'name'])
    .run(next);
};

exports.userSave = function(req, res) {
  var user = req.urlUser;
  // A user is no longer a newbie after updating their profile.
  user.newbie = false;
  // TODO: Find a better way to set multiple attributes?
  var attribs = [ 'name', 'realname', 'email', 'bio', 'website', 'location' ];
  attribs.forEach(function(attrib) {
    user[attrib] = req.body[attrib];
  });
  user.save(function(error) {
    // TODO: Redirect back to wherever user clicked "log in" from.
    if (error) {
      console.log('Error updating user:');
      console.log(error);
      res.send(500);
    } else res.redirect('/user/' + req.urlUser.pub_id);
  });
};

exports.track = function(req, res) {
  req.jadeParams.title = req.urlTrack.name;
  req.jadeParams.urlTrack = req.urlTrack;
  res.render('track', req.jadeParams);
};

exports.trackJson = function(req, res) {
  if (req.editing) {
    req.jadeParams.title = req.urlTrack.name;
    req.jadeParams.urlTrack = req.urlTrack;
    req.jadeParams.editing = true;
    req.jadeParams.validate = objects.validation.Track.validator;
    res.render('trackjson', req.jadeParams);
  } else {
    res.contentType('json');
    res.send(req.urlTrack.config);
  }
};

exports.trackJsonSave = function(req, res) {
  var track = req.urlTrack;
  track.name = req.body.name;
  track.pub_id = req.body.pub_id;
  track.config = JSON.parse(req.body.config);
  track.save(function(error) {
    if (error) {
      console.log('Error updating track:');
      console.log(error);
      res.send(500);
    } else res.redirect('/track/' + track.pub_id + '/json/edit');
  });
};

exports.car = function(req, res) {
  req.jadeParams.title = req.urlCar.name;
  req.jadeParams.urlCar = req.urlCar;
  res.render('car', req.jadeParams);
};

exports.carJson = function(req, res) {
  res.contentType('json');
  res.send(req.urlCar.config);
};

exports.drive = function(req, res) {
  topRuns(req.urlTrack.id, req.urlCar.id, 1, function(error, runs) {
    if (error) runs = [];
    req.jadeParams.title = 'Drive';
    req.jadeParams.urlTrack = req.urlTrack;
    req.jadeParams.urlCar = req.urlCar;
    req.jadeParams.runs = runs;
    res.render('drive', req.jadeParams);
  });
};

function topRuns(track, car, limit, callback) {
  Run
    .find()
    .where('track', track)
    .where('car', car)
    .where('time', { $not: { $type: 10 } })  // Exclude null times.
    .limit(limit)
    .asc('time')
    .populate('user', ['pub_id', 'name', 'email'])
    .run(callback);
};

exports.top = function(req, res) {
  topRuns(req.urlTrack.id, req.urlCar.id, 500, function(error, runs) {
    if (error) {
      console.log('Error fetching runs:');
      console.log(error);
      res.send(500);
    } else {
      req.jadeParams.title = 'Top times';
      req.jadeParams.urlTrack = req.urlTrack;
      req.jadeParams.urlCar = req.urlCar;
      req.jadeParams.runs = runs;
      res.render('top', req.jadeParams);
    }
  });
};

exports.run = function(req, res) {
  req.jadeParams.title = req.urlRun.name;
  req.jadeParams.urlRun = req.urlRun;
  res.render('run', req.jadeParams);
};

exports.runSave = function(req, res) {
  if (req.user && req.user.user && req.user.user.pub_id == req.body.user) {
    async.parallel({
      car: function(cb){
        Car.findOne({ pub_id: req.body.car }, function(err, doc){
          cb(err, doc);
        });
      },
      track: function(cb){
        Track.findOne({ pub_id: req.body.track }, function(err, doc){
          cb(err, doc);
        });
      }
    }, function(error, data) {
      if (error) {
        console.log('Error fetching data for run:');
        console.log(error);
        res.send(500);
      } else {
        if (!data.car) {
          console.log('Error loading car');
          res.send(500);
        } else if (!data.track) {
          console.log('Error loading track');
          res.send(500);
        } else {
          var run = new Run({
            user: req.user.user,
            car: data.car,
            track: data.track,
            status: 'Unverified',
            time: JSON.parse(req.body.time),
            record_i: JSON.parse(req.body.record_i),
            record_p: JSON.parse(req.body.record_p)
          });
          run.save(function(error) {
            if (error) {
              console.log('Error saving run:');
              console.log(error);
              res.send(500);
            } else {
              res.send(JSON.stringify({
                run: run.pub_id
              }));
              // We duplicate params because they're not populated in run. Bug?
              //verifyRun(run, req.user, data.track, data.car);
            }
          });
        }
      }
    });
  } else {
    res.send(401);
  }
};

exports.runReplay = function(req, res) {
  req.jadeParams.urlRun = req.urlRun;
  res.render('replay', req.jadeParams);
};

function verifyRun(run, user, track, car) {
  var shared = require('../shared');
  var game = new shared.Game(require('http'));
  async.parallel({
    track: function(cb) {
      game.setTrackConfig(track.config, cb);
    },
    progress: function(cb) {
      game.addCarConfig(car.config, function(err, progress) {
        if (err) throw new Error(err);
        else cb(null, progress);
      });
    },
  }, function(err, data) {
    if (err) throw new Error(err);
    else {
      var input = {};
      var vehicle = data.progress.vehicle;
      var vehicleInput = vehicle.controller.input;
      var record = run.input;
      var recordIndex = 0;
      var nextRecordIndex = 0;
      var timeline = record.timeline;
      var keys = {
        nextCpIndex: 0,
        vehicle: {
          body: {
            pos: {x:3,y:3,z:3},
            ori: {x:3,y:3,z:3,w:3},
            linVel: {x:3,y:3,z:3},
            angVel: {x:3,y:3,z:3}
          },
          controller: {
            input: {
              forward: 0,
              back: 0,
              left: 0,
              right: 0,
              handbrake: 0
            }
          },
          wheels: [{
            spinVel: 1
          }],
          engineAngVel: 3
        }
      };
      var playback = new recorder.StateRecorder(data.progress, keys, 20);
      var inputKeyMap = record.keyMap;
      // New record format will change index sync.
      timeline.forEach(function(segment) {
        var duration = segment[0];
        var inputData = segment[1];
        nextRecordIndex += duration;
        if (nextRecordIndex > 100000) {
          console.log('verifyRun: nextRecordIndex too large: ' + nextRecordIndex);
          return;  // DOS protection.
        }
        // Update to new input values.
        // TODO: Build this functionality into recorder.
        for (var k in inputData) {
          input[inputKeyMap[k]] = parseFloat(inputData[k]);
        }
        // Update simulation
        for (; recordIndex < nextRecordIndex; ++recordIndex) {
          // Write input values every time.
          _.extend(vehicleInput, input);
          playback.observe();
          game.sim.step();
        }
      });
      if (data.progress.cpTimes.length == data.progress.checkpoints.length) {
        run.status = 'Verified';
        run.time = _.last(data.progress.cpTimes) - game.startTime;
      } else {
        run.status = 'Error';
      }
      run.playback = playback.serialize();
      run.save(function(error) {
        if (error) {
          console.log('Error processing run:');
          console.log(error);
        }
      });
    }
  });
};

exports.metricsSave = function(req, res) {
  // Don't make the browser wait for this to finish.
  res.send(200);
  async.parallel({
    car: function(cb){
      Car.findOne({ pub_id: req.body.car }, function(err, doc){
        cb(err, doc);
      });
    },
    track: function(cb){
      Track.findOne({ pub_id: req.body.track }, function(err, doc){
        cb(err, doc);
      });
    }
  }, function(error, data) {
    if (error) {
      console.log('Error fetching data for metrics:');
      console.log(error);
    } else {
      if (!data.car) {
        console.log('Error loading car for metrics');
      } else if (!data.track) {
        console.log('Error loading track for metrics');
      } else {
        var params = req.body;
        params.performanceData = JSON.parse(params.performanceData);
        params.userAgent = req.headers['user-agent'];
        params.car = data.car;
        params.track = data.track;
        var metricsRecord = new MetricsRecord(params);
        metricsRecord.save(function(error) {
          if (error) {
            console.log('Error saving metrics:');
            console.log(error);
          }
        });
      }
    }
  });
};

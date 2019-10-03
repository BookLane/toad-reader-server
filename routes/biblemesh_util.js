var moment = require('moment');

var getXapiActor = function(params) {
  return {
    "name": params.req.user.firstname + " " + params.req.user.lastname,
    "mbox": "mailto:" + params.req.user.email,
  };
}

var getXapiObject = function(params) {
  var baseUrl = biblemesh_util.getBaseUrl(params.req);

  return {
    "id": baseUrl + "/book/" + params.bookId,
    "definition": {
      "type": "http://id.tincanapi.com/activitytype/book",
      "name": {
        "en-gb": params.bookTitle,
      },
      // "moreInfo": "https://sandbox.biblemesh.com/index.php?route=product/product&product_id=246",
      "extensions": Object.assign(
        {
          "http://id.tincanapi.com/extension/isbn": params.bookISBN,
        },
        (params.spineIdRef
          ? {
            "http://id.tincanapi.com/activitytype/chapter": baseUrl + "/book/" + params.bookId + "?goto=" + encodeURIComponent('{"idref":"' + params.spineIdRef.replace(/"/g, '\\"') + '"}'),
          }
          : {}
        )
        // "http://lrs.resourcingeducation.com/extension/recurring-subscriptions": [
        //   {
        //     "id": "2"
        //   }
        // ]
      )
    },
    "objectType": "Activity"
  };
}

var getXapiContext = function(params) {
  var appURI = biblemesh_util.getBaseUrl(params.req);
  var platform =
    params.req
    && params.req.headers
    && params.req.headers['x-platform']

  if(platform === 'ios') {
    appURI = params.req.user.idpIosAppURL || "https://itunes.apple.com";
  }
  
  if(platform === 'android') {
    appURI = params.req.user.idpAndroidAppURL || "https://play.google.com";
  }

  return {
    "platform": "Toad Reader",
    "language": "en-gb",
    "contextActivities": {
      "grouping": [
        {
          "id": appURI,
          "definition": {
            "type": "http://activitystrea.ms/schema/1.0/application",
            "name": {
              "en-gb": "BibleMesh Reader (" + (platform || 'web') + ")"
            }
          },
          "objectType": "Activity"
        },
      ],
      "category": [
        {
          "id": "https://toadreader.com",
          "definition": {
            "type": "http://id.tincanapi.com/activitytype/source",
            "name": {
              "en-gb": "Toad Reader"
            }
          },
          "objectType": "Activity"
        },
      ]
    }
  };
}

var biblemesh_util = {

  NOT_DELETED_AT_TIME: '0000-01-01 00:00:00',
  
  getUTCTimeStamp: function(){
    return new Date().getTime();
  },

  notLaterThanNow: function(timestamp){
    return Math.min(biblemesh_util.getUTCTimeStamp(), timestamp);
  },

  mySQLDatetimeToTimestamp: function(mysqlDatetime) {
    // Split timestamp into [ Y, M, D, h, m, s, ms ]
    var t = mysqlDatetime.split(/[- :\.]/);

    // Apply each element to the Date function
    var d = new Date(Date.UTC(t[0], t[1]-1, t[2], t[3], t[4], t[5], t[6] || 0));

    return d.getTime();
  },

  timestampToMySQLDatetime: function(timestamp, doMilliseconds) {
    var specifyDigits = function(number, digits) {
      return ('0000000000000' + number).substr(digits * -1);
    }

    var date = timestamp ? new Date(timestamp) : new Date();

    var formatted = date.getUTCFullYear() + "-"
      + specifyDigits(1 + date.getUTCMonth(), 2) + "-"
      + specifyDigits(date.getUTCDate(), 2) + " "
      + specifyDigits(date.getUTCHours(), 2) + ":"
      + specifyDigits(date.getUTCMinutes(), 2) + ":"
      + specifyDigits(date.getUTCSeconds(), 2);
    
    if(doMilliseconds) {
      formatted += "." + specifyDigits(date.getMilliseconds(), 3);
    }

    return formatted;
  },

  timestampToISO: function(timestamp) {
    var date = timestamp ? new Date(timestamp) : new Date();

    return date.toISOString();
  },

  secondsToDuration: function(seconds) {
    return moment.duration(seconds, 'seconds').toISOString();
    // Eg. P3Y6M4DT12H30M5S
  },

  pad: function(num, size) {
    var s = num+"";
    while (s.length < size) s = "0" + s;
    return s;
  },

  getBaseUrl: function(req) {
    return (req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.REQUIRE_HTTPS
      ? 'https' 
      : 'http'
    ) + '://' + req.headers.host;
  },

  // xAPI statement utils below

  getReadStatement: function(params) {
    return JSON.stringify({
      "actor": getXapiActor(params),
      "verb": {
        "id": "http://activitystrea.ms/schema/1.0/consume",
        "display": {
          "en-gb": "consumed"
        }
      },
      "object": getXapiObject(params),
      "result": {
        "duration": biblemesh_util.secondsToDuration(params.durationInSeconds),
      },
      "timestamp": biblemesh_util.timestampToISO(params.timestamp),
      "context": getXapiContext(params),
    });
  },

  getAnnotateStatement: function(params) {
    return JSON.stringify({
      "actor": getXapiActor(params),
      "verb": {
        "id": "http://risc-inc.com/annotator/verbs/annotated",
        "display": {
          "en-gb": "annotated"
        }
      },
      "object": getXapiObject(params),
      "timestamp": biblemesh_util.timestampToISO(params.timestamp),
      "context": getXapiContext(params),
    });
  },

  getDownloadStatement: function(params) {
    return JSON.stringify({
      "actor": getXapiActor(params),
      "verb": {
        "id": "http://id.tincanapi.com/verb/downloaded",
        "display": {
          "en-gb": "downloaded"
        }
      },
      "object": getXapiObject(params),
      "timestamp": biblemesh_util.timestampToISO(params.timestamp),
      "context": getXapiContext(params),
    });
  },
}

module.exports = biblemesh_util;
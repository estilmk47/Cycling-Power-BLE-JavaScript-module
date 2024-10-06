import * as BIKE from './../../cycling_power_ble.module.js'
let session = new BIKE.Session();

class Graph{
    static minutes = 60;
    constructor(dom){
        this.canvas = dom;
        this.windowTimeLength = 3*Graph.minutes; // [s]
    }

     
    drawPower(powerArray, timeArray){

    }
    drawSpeed(speedArray, timeArray){

    }
    drawCadence(){
        
    }
    drawPulse(pulseArray, timeArray, avgPulse = null, maxPulse = null){

    }
}

let graph = new Graph();


function renderer(){

    let sessionStats = session.getStats();
    console.log(sessionStats)

    // requestAnimationFrame(renderer);
}
renderer();
// requestAnimationFrame(renderer);
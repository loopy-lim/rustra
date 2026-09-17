// This entire extension runs only with --inspect. Timed production slices above
// remain byte-identical. The shim getter observes the actual resident under lock.
namespace {
struct StackTrace {
  std::vector<size_t> capacitySequence;
  size_t maxLive = 0;
  void observe(const std::vector<size_t>& stack) {
    if (capacitySequence.empty() || capacitySequence.back() != stack.capacity())
      capacitySequence.push_back(stack.capacity());
    maxLive = std::max(maxLive, stack.size());
  }
};
// GENERATED_STACK_PROBE
void emitTree(std::ostream& out, const ParityTree& tree) {
  out << "{\"nodes\":[";
  for (size_t i=0; i<tree.nodes.size(); ++i) {
    if(i) out<<",";
    const auto& n=tree.nodes[i];
    out<<"{\"id\":"<<n.id<<",\"name\":"<<std::quoted(n.name)
       <<",\"tag\":"<<std::quoted(n.tag)<<",\"note\":";
    if(n.note) out<<std::quoted(*n.note); else out<<"null";
    out<<",\"metadata\":{";
    std::map<std::string,std::string> ordered(n.metadata.begin(),n.metadata.end());
    bool comma=false;
    for(const auto& [key,value]:ordered) {
      if(comma)out<<",";comma=true;out<<std::quoted(key)<<":"<<std::quoted(value);
    }
    out<<"},\"children\":[";
    for(size_t j=0;j<n.children.size();++j){if(j)out<<",";out<<n.children[j];}
    out<<"]}";
  }
  out<<"]}";
}
void emitHistogram(std::ostream& out,const std::map<size_t,size_t>& values) {
  out<<"{";bool comma=false;
  for(const auto& [capacity,count]:values){if(comma)out<<",";comma=true;out<<std::quoted(std::to_string(capacity))<<":"<<count;}
  out<<"}";
}
}
void HybridNitroBench::diagnosticInspect(std::ostream& out,double id) {
  std::lock_guard<std::mutex> lock(mutex_);
  if(!resident_)throw std::runtime_error("inspection requires final resident");
  const auto& tree=*resident_;
  StackTrace trace;
  const auto result=search_probe(tree,id,trace);
  std::map<size_t,size_t> childCaps,metadataBuckets;
  size_t childSum=0,emptyAllocated=0,nonemptyAllocated=0,metadataEntries=0;
  for(const auto& n:tree.nodes){
    ++childCaps[n.children.capacity()];++metadataBuckets[n.metadata.bucket_count()];
    childSum+=n.children.capacity();metadataEntries+=n.metadata.size();
    if(n.children.capacity()) { if(n.children.empty())++emptyAllocated; else ++nonemptyAllocated; }
  }
  out<<"\"residentCapacityEvidence\":\"observed actual final resident through diagnostic-only shim getter under mutex\","
     <<"\"residentCapacitiesObserved\":{\"nodeCapacity\":"<<tree.nodes.capacity()
     <<",\"childCapacitySum\":"<<childSum<<",\"childCapacityDistribution\":";
  emitHistogram(out,childCaps);
  out<<",\"nonemptyChildrenWithAllocation\":"<<nonemptyAllocated
     <<",\"emptyChildrenWithAllocation\":"<<emptyAllocated
     <<",\"metadataEntries\":"<<metadataEntries<<",\"metadataBucketCountDistribution\":";
  emitHistogram(out,metadataBuckets);
  out<<"},\"finalResident\":";emitTree(out,tree);
  out<<",\"stackProbe\":{\"capacitySequence\":[";
  for(size_t i=0;i<trace.capacitySequence.size();++i){if(i)out<<",";out<<trace.capacitySequence[i];}
  out<<"],\"initialAllocationCount\":"<<(!tree.nodes.empty()?1:0)
     <<",\"growthCountAfterInitial\":"<<(trace.capacitySequence.size()-1)
     <<",\"maxLive\":"<<trace.maxLive
     <<",\"result\":{\"found\":"<<(result.found?"true":"false")<<",\"id\":"<<result.id
     <<",\"name\":"<<std::quoted(result.name)<<",\"visited\":"<<result.visited
     <<"},\"scope\":\"separate instrumented search of final resident under mutex, outside timing\"}";
}
